#pragma once

#include <chrono>
#include <cstdint>
#include <memory>
#include <vector>

#include "core/config.hpp"
#include "core/scenario.hpp"
#include "core/vessel.hpp"

namespace seatrace::sim {

// The complete simulated fleet. Everything here is single-threaded and deterministic: for a given
// configuration, seed, start time and sequence of scenario commands / steps, the readings are
// bit-identical between runs.
class Simulation {
 public:
  Simulation(const FleetConfig& config, std::uint32_t seed, SimTime start);

  // Advances simulation time by `dt`, expires timed scenarios and steps every vessel.
  void step(std::chrono::milliseconds dt);

  SimTime now() const { return now_; }
  std::uint32_t seed() const { return seed_; }
  // Number of completed steps (the Heartbeat node).
  std::uint64_t heartbeat() const { return heartbeat_; }

  const std::vector<std::unique_ptr<Vessel>>& vessels() const { return vessels_; }
  const Vessel* find_vessel(std::string_view code) const;
  ScenarioManager& scenarios() { return scenarios_; }
  const ScenarioManager& scenarios() const { return scenarios_; }

  // Events since the last call, for logging.
  std::vector<StateChange> take_state_changes();
  std::vector<ActiveScenario> take_expired_scenarios();

 private:
  void advance_vessels(double dt_s);

  std::uint32_t seed_;
  SimTime now_;
  double elapsed_s_ = 0.0;
  std::uint64_t heartbeat_ = 0;
  ScenarioManager scenarios_;
  std::vector<std::unique_ptr<Vessel>> vessels_;
  std::vector<ActiveScenario> expired_;
};

}  // namespace seatrace::sim
