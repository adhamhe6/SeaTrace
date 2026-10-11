#pragma once

#include <memory>
#include <string>
#include <vector>

#include "core/bilge_system.hpp"
#include "core/cooling_system.hpp"
#include "core/equipment.hpp"
#include "core/main_engine.hpp"

namespace seatrace::sim {

// One vessel: its equipment plus the physical coupling between them. The first CoolingSystem
// feeds its effectiveness to every MainEngine and receives the temperature of the first
// MainEngine; the cooling system is stepped first so the engine always sees its current state.
class Vessel {
 public:
  Vessel(const VesselConfig& config, std::uint64_t seed);

  void step(double dt_s, double elapsed_s, SimTime now, const ScenarioView& scenarios);

  const std::string& code() const { return code_; }
  const std::string& name() const { return name_; }
  const std::vector<std::unique_ptr<Equipment>>& equipment() const { return equipment_; }
  const Equipment* find_equipment(std::string_view code) const;

  // True while the telemetry_interruption scenario is active: the publisher must not write any
  // value or timestamp of this vessel.
  bool telemetry_interrupted() const { return telemetry_interrupted_; }

  std::vector<StateChange> take_state_changes();

 private:
  std::string code_;
  std::string name_;
  std::vector<std::unique_ptr<Equipment>> equipment_;
  const MainEngine* engine_ = nullptr;  // first main engine (non-owning)
  CoolingSystem* cooling_ = nullptr;    // first cooling system (non-owning)
  bool telemetry_interrupted_ = false;
};

}  // namespace seatrace::sim
