#include <gtest/gtest.h>

#include "test_support.hpp"

namespace seatrace::sim {
namespace {

using namespace testing;
using namespace std::chrono_literals;

// Runs a scripted session (scenarios activated and cleared at fixed ticks) and records the
// bit pattern of every published value after every tick.
std::vector<std::vector<std::uint64_t>> scripted_run(std::uint32_t seed,
                                                     bool shift_command = false) {
  Simulation sim = make_simulation(seed);
  std::vector<std::vector<std::uint64_t>> trace;
  for (int tick = 0; tick < 900; ++tick) {
    if (tick == 100) sim.scenarios().activate("VES-001", "engine_overheat", 0, sim.now());
    if (tick == (shift_command ? 121 : 120)) {
      sim.scenarios().activate("VES-002", "sensor_stuck", 0, sim.now());
    }
    if (tick == 200) sim.scenarios().activate("VES-001", "bilge_flooding", 60, sim.now());
    if (tick == 300) sim.scenarios().activate("VES-002", "sensor_failure", 0, sim.now());
    if (tick == 330) sim.scenarios().clear("VES-002", "sensor_failure");
    if (tick == 400) sim.scenarios().clear("VES-001", "engine_overheat");
    sim.step(1s);
    trace.push_back(snapshot_bits(sim));
  }
  return trace;
}

TEST(Determinism, SameSeedAndCommandsGiveBitIdenticalOutput) {
  EXPECT_EQ(scripted_run(42), scripted_run(42));
}

TEST(Determinism, DifferentSeedsDiffer) {
  const auto a = scripted_run(42);
  const auto b = scripted_run(43);
  EXPECT_NE(a, b);
  // ... and they differ in the noise of ordinary readings, not just somewhere late.
  EXPECT_NE(a[1], b[1]);
}

TEST(Determinism, TheSequenceOfCommandsMatters) {
  EXPECT_NE(scripted_run(42), scripted_run(42, /*shift_command=*/true));
}

TEST(Determinism, EveryRunStartsFromTheSameStateRegardlessOfWallClock) {
  Simulation a(default_fleet(), 7, kStartTime);
  Simulation b(default_fleet(), 7, kStartTime + 10s);
  EXPECT_EQ(snapshot_bits(a), snapshot_bits(b)) << "only the timestamps differ";
}

TEST(Determinism, VesselsAndSensorsUseIndependentStreams) {
  Simulation sim = make_simulation(5);
  run_seconds(sim, 10);
  // Same noise would make the residuals of two sensors identical; independent streams do not.
  const auto residual = [&](std::string_view vessel, std::string_view code, std::string_view key) {
    return reading(sim, vessel, code, key).value - truth(sim, vessel, code, key);
  };
  EXPECT_NE(residual("VES-001", "ME1", "rpm") / 0.4, residual("VES-001", "ME1", "load") / 0.5);
  EXPECT_NE(residual("VES-001", "ME1", "rpm") / 0.4, residual("VES-002", "ME1", "rpm") / 0.45);
}

TEST(Determinism, AddingAScenarioToOneVesselDoesNotChangeTheNoiseOfTheOther) {
  Simulation reference = make_simulation(9);
  Simulation disturbed = make_simulation(9);
  ASSERT_TRUE(
      disturbed.scenarios().activate("VES-001", "engine_overheat", 0, disturbed.now()).accepted);
  for (int i = 0; i < 120; ++i) {
    reference.step(1s);
    disturbed.step(1s);
  }
  for (const char* code : {"ME1", "GEN1", "COOL1", "BILGE1"}) {
    for (const Sensor& sensor : equipment(reference, "VES-002", code).sensors()) {
      EXPECT_EQ(sensor.reading().value,
                equipment(disturbed, "VES-002", code).sensor(sensor.spec().key).reading().value)
          << code << "." << sensor.spec().key;
    }
  }
}

}  // namespace
}  // namespace seatrace::sim
