#pragma once

#include <gtest/gtest.h>

#include <bit>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "core/config.hpp"
#include "core/simulation.hpp"

namespace seatrace::sim::testing {

using namespace std::chrono_literals;

// 2026-01-01T12:00:00Z
inline const SimTime kStartTime{std::chrono::seconds(1767268800)};

inline FleetConfig default_fleet() { return load_fleet_config(SEATRACE_FLEET_CONFIG); }

inline Simulation make_simulation(std::uint32_t seed = 42) {
  return Simulation(default_fleet(), seed, kStartTime);
}

inline void run_seconds(Simulation& sim, int seconds) {
  for (int i = 0; i < seconds; ++i) sim.step(1s);
}

inline const Equipment& equipment(const Simulation& sim, std::string_view vessel,
                                  std::string_view code) {
  const Vessel* v = sim.find_vessel(vessel);
  EXPECT_NE(v, nullptr) << vessel;
  const Equipment* e = v->find_equipment(code);
  EXPECT_NE(e, nullptr) << code;
  return *e;
}

inline EquipmentState state_of(const Simulation& sim, std::string_view vessel,
                               std::string_view code) {
  return equipment(sim, vessel, code).state();
}

inline double truth(const Simulation& sim, std::string_view vessel, std::string_view code,
                    std::string_view key) {
  return equipment(sim, vessel, code).true_value(key);
}

inline const Reading& reading(const Simulation& sim, std::string_view vessel, std::string_view code,
                              std::string_view key) {
  return equipment(sim, vessel, code).sensor(key).reading();
}

// Steps one second at a time until `done()` or `limit_s` seconds; returns the seconds stepped.
template <typename Predicate>
int run_until(Simulation& sim, Predicate done, int limit_s) {
  int elapsed = 0;
  while (elapsed < limit_s && !done()) {
    sim.step(1s);
    ++elapsed;
  }
  return elapsed;
}

inline void activate(Simulation& sim, std::string_view vessel, std::string_view scenario,
                     std::uint32_t duration_s = 0) {
  const ScenarioResult result = sim.scenarios().activate(vessel, scenario, duration_s, sim.now());
  ASSERT_TRUE(result.accepted) << result.message;
}

inline void clear(Simulation& sim, std::string_view vessel, std::string_view scenario) {
  const ScenarioResult result = sim.scenarios().clear(vessel, scenario);
  ASSERT_TRUE(result.accepted) << result.message;
}

// Bit pattern of every published reading, for exact reproducibility checks.
inline std::vector<std::uint64_t> snapshot_bits(const Simulation& sim) {
  std::vector<std::uint64_t> bits;
  for (const auto& vessel : sim.vessels()) {
    for (const auto& equipment : vessel->equipment()) {
      bits.push_back(static_cast<std::uint64_t>(equipment->state()));
      bits.push_back(static_cast<std::uint64_t>(equipment->sensor_health()));
      for (const Sensor& sensor : equipment->sensors()) {
        bits.push_back(std::bit_cast<std::uint64_t>(sensor.reading().value));
        bits.push_back(static_cast<std::uint64_t>(sensor.reading().quality));
      }
    }
  }
  return bits;
}

}  // namespace seatrace::sim::testing
