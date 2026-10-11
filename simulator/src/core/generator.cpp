#include "core/generator.hpp"

#include <algorithm>
#include <cmath>

#include "core/math_util.hpp"

namespace seatrace::sim {

namespace {
constexpr double kDisturbanceTauS = 60.0;
constexpr double kStartingFrequencyFraction = 0.8;
constexpr double kOverloadHysteresisPct = 2.0;
}  // namespace

Generator::Params Generator::Params::from(const EquipmentConfig& config) {
  const ParamSet params(config.type, config.rated, config.parameters);
  return {params.get("power_kw"),         params.get("frequency_hz"),
          params.get("start_duration_s"), params.get("demand_period_s"),
          params.get("demand_phase_rad"), params.get("demand_noise_pct"),
          params.get("droop_hz"),         params.get("load_tau_s"),
          params.get("frequency_tau_s"),  params.get("overload_margin_pct")};
}

Generator::Generator(const EquipmentConfig& config, std::string vessel_id, std::uint64_t seed)
    : Equipment(config, vessel_id, seed),
      p_(Params::from(config)),
      load_spec_(config.measurement("load")),
      process_rng_(derive_seed(seed, vessel_id + "." + config.code + "#process")) {
  if (config.initial_state == EquipmentState::kRunning) {
    load_ = load_spec_.nominal_mid();
    frequency_ = loaded_frequency(load_);
  } else if (config.initial_state == EquipmentState::kStarting) {
    frequency_ = kStartingFrequencyFraction * p_.rated_frequency_hz;
  }
}

double Generator::loaded_frequency(double load_pct) const {
  return p_.rated_frequency_hz + p_.droop_hz * (0.5 - load_pct / 100.0);
}

double Generator::true_value(std::string_view key) const {
  if (key == "power_output") return load_ / 100.0 * p_.rated_power_kw;
  if (key == "frequency") return frequency_;
  return load_;
}

double Generator::demand(const StepContext& context) {
  const double decay = std::exp(-context.dt_s / kDisturbanceTauS);
  disturbance_ = disturbance_ * decay +
                 p_.demand_noise_pct * std::sqrt(1.0 - decay * decay) * process_rng_.gaussian();
  const double profile =
      load_spec_.nominal_mid() +
      0.8 * load_spec_.nominal_half_range() *
          std::sin(kTwoPi * context.elapsed_s / p_.demand_period_s + p_.demand_phase_rad);
  return std::clamp(profile + disturbance_, 0.0, 100.0);
}

void Generator::advance(const StepContext& context) {
  const double demanded = demand(context);
  const bool online = state() == EquipmentState::kRunning || state() == EquipmentState::kDegraded;
  load_ = first_order(load_, online ? demanded : 0.0, context.dt_s, p_.load_tau_s);

  double target_frequency = 0.0;
  if (online) {
    target_frequency = loaded_frequency(load_);
  } else if (state() == EquipmentState::kStarting) {
    target_frequency = kStartingFrequencyFraction * p_.rated_frequency_hz;
  }
  frequency_ = first_order(frequency_, target_frequency, context.dt_s, p_.frequency_tau_s);

  const SimTime now = context.now;
  const double overload_limit = load_spec_.nominal_max + p_.overload_margin_pct;
  switch (state()) {
    case EquipmentState::kStopped:
      if (auto_start_due(now)) set_state(EquipmentState::kStarting, now);
      break;
    case EquipmentState::kStarting:
      if (state_age_s(now) >= p_.start_duration_s) set_state(EquipmentState::kRunning, now);
      break;
    case EquipmentState::kRunning:
      if (load_ > overload_limit) set_state(EquipmentState::kDegraded, now);
      break;
    case EquipmentState::kDegraded:
      if (load_ < overload_limit - kOverloadHysteresisPct) set_state(EquipmentState::kRunning, now);
      break;
    default:
      break;
  }
}

}  // namespace seatrace::sim
