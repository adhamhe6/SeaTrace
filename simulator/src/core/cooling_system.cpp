#include "core/cooling_system.hpp"

#include <cmath>

#include "core/math_util.hpp"

namespace seatrace::sim {

namespace {
constexpr double kLossPressureBar = 0.6;  // pressure the cooling_pressure_loss scenario decays to
constexpr double kLossRampS = 30.0;
constexpr double kLossRecoveryS = 20.0;
constexpr double kMinEffectiveness = 0.6;  // no flow at all
constexpr double kRecoveryPressureMarginBar = 0.2;
}  // namespace

CoolingSystem::Params CoolingSystem::Params::from(const EquipmentConfig& config) {
  const ParamSet params(config.type, config.rated, config.parameters);
  return {params.get("pressure_bar"),
          params.get("pressure_tau_s"),
          params.get("temperature_tau_s"),
          params.get("sea_temperature_c"),
          params.get("engine_coupling"),
          params.get("degraded_pressure_bar"),
          params.get("degraded_temperature_margin_c"),
          params.get("pressure_wobble_bar"),
          params.get("wobble_period_s")};
}

CoolingSystem::CoolingSystem(const EquipmentConfig& config, const std::string& vessel_id,
                             std::uint64_t seed)
    : Equipment(config, vessel_id, seed),
      p_(Params::from(config)),
      temperature_spec_(config.measurement("temperature")) {
  const bool running = config.initial_state == EquipmentState::kRunning;
  pressure_ = running ? p_.rated_pressure_bar : 0.0;
  temperature_ = running ? temperature_spec_.nominal_mid() : p_.sea_temperature_c;
}

double CoolingSystem::effectiveness() const {
  return kMinEffectiveness + (1.0 - kMinEffectiveness) * clamp01(pressure_ / p_.rated_pressure_bar);
}

double CoolingSystem::true_value(std::string_view key) const {
  return key == "pressure" ? pressure_ : temperature_;
}

void CoolingSystem::advance(const StepContext& context) {
  const bool pumping = state() == EquipmentState::kRunning || state() == EquipmentState::kDegraded;
  loss_level_ = ramp_level(loss_level_, scenario_active(context, ScenarioId::kCoolingPressureLoss),
                           context.dt_s, kLossRampS, kLossRecoveryS);

  double target_pressure = 0.0;
  if (pumping) {
    const double ripple =
        p_.pressure_wobble_bar * std::sin(kTwoPi * context.elapsed_s / p_.wobble_period_s);
    target_pressure =
        (p_.rated_pressure_bar + ripple) * (1.0 - loss_level_) + kLossPressureBar * loss_level_;
  }
  pressure_ = first_order(pressure_, target_pressure, context.dt_s, p_.pressure_tau_s);

  const double target_temperature =
      context.engine_temperature_c
          ? p_.sea_temperature_c +
                p_.engine_coupling * (*context.engine_temperature_c - p_.sea_temperature_c)
          : temperature_spec_.nominal_mid();
  temperature_ = first_order(temperature_, target_temperature, context.dt_s, p_.temperature_tau_s);

  const SimTime now = context.now;
  const double temperature_limit = temperature_spec_.nominal_max + p_.degraded_temperature_margin_c;
  switch (state()) {
    case EquipmentState::kStopped:
      if (auto_start_due(now)) set_state(EquipmentState::kRunning, now);
      break;
    case EquipmentState::kRunning:
      if (pressure_ < p_.degraded_pressure_bar || temperature_ > temperature_limit) {
        set_state(EquipmentState::kDegraded, now);
      }
      break;
    case EquipmentState::kDegraded:
      if (pressure_ > p_.degraded_pressure_bar + kRecoveryPressureMarginBar &&
          temperature_ <= temperature_spec_.nominal_max) {
        set_state(EquipmentState::kRunning, now);
      }
      break;
    default:
      break;
  }
}

}  // namespace seatrace::sim
