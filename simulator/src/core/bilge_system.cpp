#include "core/bilge_system.hpp"

#include <algorithm>
#include <cmath>

#include "core/math_util.hpp"

namespace seatrace::sim {

namespace {
constexpr double kFloodRampS = 8.0;
constexpr double kFloodRecoveryS = 20.0;
constexpr double kDegradedHysteresisCm = 5.0;
}  // namespace

BilgeSystem::Params BilgeSystem::Params::from(const EquipmentConfig& config) {
  const ParamSet params(config.type, config.rated, config.parameters);
  return {params.get("pump_capacity_cm_per_s"),
          params.get("pump_start_level_cm"),
          params.get("pump_stop_level_cm"),
          params.get("baseline_level_cm"),
          params.get("relaxation_s"),
          params.get("inflow_sigma_cm_per_s"),
          params.get("flood_ingress_cm_per_s"),
          params.get("degraded_level_cm"),
          params.get("max_level_cm")};
}

BilgeSystem::BilgeSystem(const EquipmentConfig& config, const std::string& vessel_id,
                         std::uint64_t seed)
    : Equipment(config, vessel_id, seed),
      p_(Params::from(config)),
      process_rng_(derive_seed(seed, vessel_id + "." + config.code + "#process")) {
  level_ = config.initial_state == EquipmentState::kPumping
               ? 0.5 * (p_.pump_start_level + p_.pump_stop_level)
               : p_.baseline_level;
}

double BilgeSystem::true_value(std::string_view /*key*/) const { return level_; }

void BilgeSystem::advance(const StepContext& context) {
  const double dt = context.dt_s;
  flood_level_ = ramp_level(flood_level_, scenario_active(context, ScenarioId::kBilgeFlooding), dt,
                            kFloodRampS, kFloodRecoveryS);

  const bool pump_on = state() == EquipmentState::kPumping || state() == EquipmentState::kDegraded;
  const double seepage_noise = p_.inflow_sigma * std::sqrt(dt) * process_rng_.gaussian();
  const double drift = (p_.baseline_level - level_) / p_.relaxation_s * dt;
  const double ingress = flood_level_ * p_.flood_ingress * dt;
  const double pumped = pump_on ? p_.pump_capacity * dt : 0.0;
  level_ = std::clamp(level_ + drift + seepage_noise + ingress - pumped, 0.0, p_.max_level);

  const SimTime now = context.now;
  switch (state()) {
    case EquipmentState::kStandby:
      if (level_ > p_.pump_start_level) set_state(EquipmentState::kPumping, now);
      break;
    case EquipmentState::kPumping:
      if (level_ > p_.degraded_level) {
        set_state(EquipmentState::kDegraded, now);
      } else if (level_ < p_.pump_stop_level) {
        set_state(EquipmentState::kStandby, now);
      }
      break;
    case EquipmentState::kDegraded:
      if (level_ < p_.degraded_level - kDegradedHysteresisCm) {
        set_state(EquipmentState::kPumping, now);
      }
      break;
    default:
      break;
  }
}

}  // namespace seatrace::sim
