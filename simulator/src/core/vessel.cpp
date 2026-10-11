#include "core/vessel.hpp"

#include <algorithm>

#include "core/generator.hpp"

namespace seatrace::sim {

namespace {

std::unique_ptr<Equipment> make_equipment(const EquipmentConfig& config, const std::string& vessel,
                                          std::uint64_t seed) {
  switch (config.type) {
    case EquipmentType::kMainEngine:
      return std::make_unique<MainEngine>(config, vessel, seed);
    case EquipmentType::kGenerator:
      return std::make_unique<Generator>(config, vessel, seed);
    case EquipmentType::kCoolingSystem:
      return std::make_unique<CoolingSystem>(config, vessel, seed);
    case EquipmentType::kBilgeSystem:
      return std::make_unique<BilgeSystem>(config, vessel, seed);
  }
  return nullptr;
}

}  // namespace

Vessel::Vessel(const VesselConfig& config, std::uint64_t seed)
    : code_(config.code), name_(config.name) {
  for (const EquipmentConfig& equipment : config.equipment) {
    equipment_.push_back(make_equipment(equipment, code_, seed));
    if (engine_ == nullptr && equipment.type == EquipmentType::kMainEngine) {
      engine_ = static_cast<const MainEngine*>(equipment_.back().get());
    }
    if (cooling_ == nullptr && equipment.type == EquipmentType::kCoolingSystem) {
      cooling_ = static_cast<CoolingSystem*>(equipment_.back().get());
    }
  }
}

const Equipment* Vessel::find_equipment(std::string_view code) const {
  const auto it =
      std::ranges::find_if(equipment_, [&](const auto& e) { return e->code() == code; });
  return it == equipment_.end() ? nullptr : it->get();
}

void Vessel::step(double dt_s, double elapsed_s, SimTime now, const ScenarioView& scenarios) {
  telemetry_interrupted_ = scenarios.active(ScenarioId::kTelemetryInterruption);

  StepContext context;
  context.dt_s = dt_s;
  context.elapsed_s = elapsed_s;
  context.now = now;
  context.scenarios = scenarios;

  // Cooling first: it consumes the engine temperature of the previous step and publishes the
  // effectiveness the engine uses in this one.
  if (cooling_ != nullptr) {
    if (engine_ != nullptr) context.engine_temperature_c = engine_->temperature_c();
    cooling_->step(context);
    context.engine_temperature_c.reset();
    context.cooling_effectiveness = cooling_->effectiveness();
  }
  for (const auto& equipment : equipment_) {
    if (equipment.get() != cooling_) equipment->step(context);
  }
}

std::vector<StateChange> Vessel::take_state_changes() {
  std::vector<StateChange> all;
  for (const auto& equipment : equipment_) {
    auto changes = equipment->take_state_changes();
    all.insert(all.end(), changes.begin(), changes.end());
  }
  return all;
}

}  // namespace seatrace::sim
