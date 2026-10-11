#include "core/main_engine.hpp"

#include <algorithm>
#include <cmath>

#include "core/math_util.hpp"

namespace seatrace::sim {

namespace {

constexpr double kBaseHeat = 0.3;                 // heat rejected at zero load while running
constexpr double kLoadHeat = 0.7;                 // additional heat at 100 % load
constexpr double kOverheatMaxDegradation = 0.55;  // fraction of cooling lost at full scenario level
constexpr double kOverheatRampS = 60.0;
constexpr double kOverheatRecoveryS = 45.0;
constexpr double kOverheatVibrationAdd = 0.8;  // mm/s at full overheat level
constexpr double kVibrationFactor = 2.5;       // vibration multiple at full engine_vibration level
constexpr double kVibrationTempRise = 8.0;     // K at full engine_vibration level
constexpr double kVibrationRampS = 45.0;
constexpr double kVibrationRecoveryS = 30.0;
constexpr double kDisturbanceTauS = 90.0;
constexpr double kDegradedTempMargin = 3.0;
constexpr double kDegradedVibrationMargin = 0.5;
constexpr double kStartingRpmFraction = 0.6;   // of the lower nominal rpm
constexpr double kStartingLoadFraction = 0.3;  // of the demanded load
constexpr double kMinCoolingForStart = 0.8;
constexpr double kRunningFractionRpmFloor =
    0.15;  // fraction of nominal rpm that counts as "running"

}  // namespace

MainEngine::Params MainEngine::Params::from(const EquipmentConfig& config) {
  const ParamSet params(config.type, config.rated, config.parameters);
  return {params.get("trip_temperature_c"), params.get("trip_delay_s"),
          params.get("start_duration_s"),   params.get("restart_temperature_c"),
          params.get("thermal_tau_s"),      params.get("cooldown_tau_s"),
          params.get("rpm_tau_s"),          params.get("load_tau_s"),
          params.get("ambient_c"),          params.get("load_period_s"),
          params.get("load_phase_rad"),     params.get("load_noise_pct")};
}

MainEngine::MainEngine(const EquipmentConfig& config, std::string vessel_id, std::uint64_t seed)
    : Equipment(config, vessel_id, seed),
      p_(Params::from(config)),
      rpm_spec_(config.measurement("rpm")),
      temperature_spec_(config.measurement("temperature")),
      vibration_spec_(config.measurement("vibration")),
      load_spec_(config.measurement("load")),
      process_rng_(derive_seed(seed, vessel_id + "." + config.code + "#process")) {
  // Calibrate so that nominal load and nominal cooling give the middle of the nominal band.
  const double nominal_heat = kBaseHeat + kLoadHeat * load_spec_.nominal_mid() / 100.0;
  heat_gain_ = (temperature_spec_.nominal_mid() - p_.ambient_c) / nominal_heat;

  // Start from the steady state of the configured initial state.
  const bool running = config.initial_state == EquipmentState::kRunning;
  const bool starting = config.initial_state == EquipmentState::kStarting;
  load_ = running ? load_spec_.nominal_mid() : 0.0;
  rpm_ = running ? rpm_spec_.nominal_mid()
                 : (starting ? kStartingRpmFraction * rpm_spec_.nominal_min : 0.0);
  temperature_ = running ? temperature_spec_.nominal_mid() : p_.ambient_c;
  const double rpm_ratio = rpm_ / rpm_spec_.nominal_mid();
  vibration_ =
      running_fraction() * vibration_spec_.nominal_mid() * (0.25 + 0.75 * rpm_ratio * rpm_ratio);
}

double MainEngine::true_value(std::string_view key) const {
  if (key == "rpm") return rpm_;
  if (key == "temperature") return temperature_;
  if (key == "vibration") return vibration_;
  return load_;
}

double MainEngine::running_fraction() const {
  return clamp01(rpm_ / (kRunningFractionRpmFloor * rpm_spec_.nominal_mid()));
}

double MainEngine::demand_load(const StepContext& context) {
  // Ornstein-Uhlenbeck style disturbance with stationary standard deviation load_noise_pct.
  const double decay = std::exp(-context.dt_s / kDisturbanceTauS);
  demand_disturbance_ = demand_disturbance_ * decay + p_.load_noise_pct *
                                                          std::sqrt(1.0 - decay * decay) *
                                                          process_rng_.gaussian();
  const double profile =
      load_spec_.nominal_mid() +
      0.8 * load_spec_.nominal_half_range() *
          std::sin(kTwoPi * context.elapsed_s / p_.load_period_s + p_.load_phase_rad);
  return std::clamp(profile + demand_disturbance_, 0.0, 100.0);
}

void MainEngine::advance(const StepContext& context) {
  const double dt = context.dt_s;
  overheat_level_ =
      ramp_level(overheat_level_, scenario_active(context, ScenarioId::kEngineOverheat), dt,
                 kOverheatRampS, kOverheatRecoveryS);
  vibration_level_ =
      ramp_level(vibration_level_, scenario_active(context, ScenarioId::kEngineVibration), dt,
                 kVibrationRampS, kVibrationRecoveryS);

  // Targets of the mechanical side, by state.
  const double demand = demand_load(context);
  double target_load = 0.0;
  double target_rpm = 0.0;
  switch (state()) {
    case EquipmentState::kRunning:
    case EquipmentState::kDegraded: {
      target_load = demand;
      const double span = load_spec_.nominal_max - load_spec_.nominal_min;
      const double fraction = span > 0.0 ? (demand - load_spec_.nominal_min) / span : 0.5;
      target_rpm =
          rpm_spec_.nominal_min + fraction * (rpm_spec_.nominal_max - rpm_spec_.nominal_min);
      break;
    }
    case EquipmentState::kStarting:
      target_load = kStartingLoadFraction * demand;
      target_rpm = kStartingRpmFraction * rpm_spec_.nominal_min;
      break;
    default:  // STOPPED, TRIPPED
      break;
  }
  rpm_ = first_order(rpm_, target_rpm, dt, p_.rpm_tau_s);
  load_ = first_order(load_, target_load, dt, p_.load_tau_s);

  // Thermal side: heat production against cooling effectiveness.
  const double running = running_fraction();
  const double heat = running * (kBaseHeat + kLoadHeat * load_ / 100.0);
  const double effectiveness = std::max(
      0.05, context.cooling_effectiveness * (1.0 - kOverheatMaxDegradation * overheat_level_));
  const double target_temperature = p_.ambient_c + heat_gain_ * heat / effectiveness +
                                    kVibrationTempRise * vibration_level_ * running;
  temperature_ = first_order(temperature_, target_temperature, dt,
                             heat > 0.05 ? p_.thermal_tau_s : p_.cooldown_tau_s);

  // Vibration: rpm related term plus scenario terms; a stopped engine does not vibrate.
  const double rpm_ratio = rpm_ / rpm_spec_.nominal_mid();
  const double base = vibration_spec_.nominal_mid() * (0.25 + 0.75 * rpm_ratio * rpm_ratio);
  vibration_ = running *
               (base + (kVibrationFactor - 1.0) * vibration_spec_.nominal_mid() * vibration_level_ +
                kOverheatVibrationAdd * overheat_level_);

  update_state(context);
}

void MainEngine::update_state(const StepContext& context) {
  const SimTime now = context.now;
  const bool can_start = context.cooling_effectiveness >= kMinCoolingForStart &&
                         temperature_ <= p_.restart_temperature_c &&
                         !scenario_active(context, ScenarioId::kEngineOverheat);
  switch (state()) {
    case EquipmentState::kStopped:
      if (auto_start_due(now) && can_start) set_state(EquipmentState::kStarting, now);
      break;
    case EquipmentState::kStarting:
      if (state_age_s(now) >= p_.start_duration_s) set_state(EquipmentState::kRunning, now);
      break;
    case EquipmentState::kRunning:
    case EquipmentState::kDegraded: {
      above_trip_s_ = temperature_ > p_.trip_temperature_c ? above_trip_s_ + context.dt_s : 0.0;
      if (above_trip_s_ > 0.0 && above_trip_s_ >= p_.trip_delay_s) {
        above_trip_s_ = 0.0;
        set_state(EquipmentState::kTripped, now);
        break;
      }
      const bool outside_envelope =
          temperature_ > temperature_spec_.nominal_max + kDegradedTempMargin ||
          vibration_ > vibration_spec_.nominal_max + kDegradedVibrationMargin;
      const bool inside_envelope = temperature_ <= temperature_spec_.nominal_max &&
                                   vibration_ <= vibration_spec_.nominal_max;
      if (state() == EquipmentState::kRunning && outside_envelope) {
        set_state(EquipmentState::kDegraded, now);
      } else if (state() == EquipmentState::kDegraded && inside_envelope) {
        set_state(EquipmentState::kRunning, now);
      }
      break;
    }
    case EquipmentState::kTripped:
      above_trip_s_ = 0.0;
      if (can_start) set_state(EquipmentState::kStarting, now);
      break;
    default:
      break;
  }
}

}  // namespace seatrace::sim
