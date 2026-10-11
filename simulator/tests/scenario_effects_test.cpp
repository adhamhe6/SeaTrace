#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <vector>

#include "test_support.hpp"

namespace seatrace::sim {
namespace {

using namespace testing;
using namespace std::chrono_literals;

constexpr const char* kVessel = "VES-001";
constexpr const char* kOther = "VES-002";

// Mean of a true process value over the next `seconds` (the sim is advanced).
double average_truth(Simulation& sim, std::string_view vessel, std::string_view code,
                     std::string_view key, int seconds) {
  double sum = 0.0;
  for (int i = 0; i < seconds; ++i) {
    sim.step(1s);
    sum += truth(sim, vessel, code, key);
  }
  return sum / seconds;
}

// ---- engine_overheat --------------------------------------------------------------------------

TEST(EngineOverheat, RaisesEngineAndCoolantTemperatureGraduallyButNotTheBilge) {
  Simulation sim = make_simulation();
  const double engine_before = truth(sim, kVessel, "ME1", "temperature");
  const double coolant_before = truth(sim, kVessel, "COOL1", "temperature");
  const double vibration_before = truth(sim, kVessel, "ME1", "vibration");
  const double bilge_before = truth(sim, kVessel, "BILGE1", "water_level");
  activate(sim, kVessel, "engine_overheat");

  double previous = engine_before;
  double max_step = 0.0;
  for (int second = 1; second <= 60; ++second) {
    sim.step(1s);
    const double now = truth(sim, kVessel, "ME1", "temperature");
    max_step = std::max(max_step, now - previous);
    previous = now;
  }
  EXPECT_GT(previous - engine_before, 15.0)
      << "engine temperature must rise materially in a minute";
  EXPECT_LT(max_step, 1.5) << "first-order dynamics: no jumps";
  EXPECT_GT(truth(sim, kVessel, "COOL1", "temperature") - coolant_before, 4.0)
      << "cooling outlet temperature follows the engine heat rejection";
  EXPECT_GT(truth(sim, kVessel, "ME1", "vibration"), vibration_before)
      << "vibration rises slightly";
  EXPECT_LT(truth(sim, kVessel, "ME1", "vibration") - vibration_before, 2.0);
  EXPECT_LT(std::abs(truth(sim, kVessel, "BILGE1", "water_level") - bilge_before), 8.0)
      << "overheating has no effect on the bilge";
  EXPECT_EQ(state_of(sim, kVessel, "BILGE1"), EquipmentState::kStandby);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kDegraded);
}

TEST(EngineOverheat, InitialRiseIsAboutHalfADegreePerSecond) {
  Simulation sim = make_simulation();
  const double start = truth(sim, kVessel, "ME1", "temperature");
  activate(sim, kVessel, "engine_overheat");
  run_seconds(sim, 30);
  const double rate = (truth(sim, kVessel, "ME1", "temperature") - start) / 30.0;
  EXPECT_GT(rate, 0.2);
  EXPECT_LT(rate, 0.9);
}

TEST(EngineOverheat, OtherVesselIsUnaffected) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "engine_overheat");
  run_seconds(sim, 60);
  EXPECT_LT(truth(sim, kOther, "ME1", "temperature"), 90.0);
  EXPECT_EQ(state_of(sim, kOther, "ME1"), EquipmentState::kRunning);
}

TEST(EngineOverheat, ClearingFollowsARecoveryCurveInsteadOfAJump) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "engine_overheat");
  run_seconds(sim, 45);
  const double peak = truth(sim, kVessel, "ME1", "temperature");
  ASSERT_GT(peak, 98.0);
  ASSERT_LT(peak, 118.0);
  clear(sim, kVessel, "engine_overheat");

  double previous = peak;
  double max_drop_per_second = 0.0;
  for (int i = 0; i < 20; ++i) {
    sim.step(1s);
    const double now = truth(sim, kVessel, "ME1", "temperature");
    max_drop_per_second = std::max(max_drop_per_second, previous - now);
    previous = now;
  }
  EXPECT_LT(max_drop_per_second, 1.5) << "no instant jump back to normal";
  EXPECT_GT(previous, 85.0) << "still hot 20 s after clearing";
  run_seconds(sim, 400);
  EXPECT_LT(truth(sim, kVessel, "ME1", "temperature"), 90.0);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kRunning);
}

// ---- engine_vibration -------------------------------------------------------------------------

TEST(EngineVibration, RampsToAboutTwoAndAHalfTimesNominalAndHeatsTheEngineSlightly) {
  Simulation sim = make_simulation();
  const double vibration_before = average_truth(sim, kVessel, "ME1", "vibration", 20);
  const double temperature_before = average_truth(sim, kVessel, "ME1", "temperature", 1);
  const double early = (activate(sim, kVessel, "engine_vibration"),
                        average_truth(sim, kVessel, "ME1", "vibration", 10));
  EXPECT_LT(early, vibration_before * 1.8) << "a ramp, not a step";
  run_seconds(sim, 150);
  const double vibration_after = average_truth(sim, kVessel, "ME1", "vibration", 20);
  EXPECT_GT(vibration_after / vibration_before, 2.2);
  EXPECT_LT(vibration_after / vibration_before, 2.9);
  const double rise = truth(sim, kVessel, "ME1", "temperature") - temperature_before;
  EXPECT_GT(rise, 4.0);
  EXPECT_LT(rise, 14.0);
  EXPECT_NE(state_of(sim, kVessel, "ME1"), EquipmentState::kTripped);
}

TEST(EngineVibration, RecoversGradually) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "engine_vibration");
  run_seconds(sim, 120);
  const double high = truth(sim, kVessel, "ME1", "vibration");
  clear(sim, kVessel, "engine_vibration");
  sim.step(1s);
  EXPECT_GT(truth(sim, kVessel, "ME1", "vibration"), high * 0.9);
  run_seconds(sim, 120);
  EXPECT_LT(truth(sim, kVessel, "ME1", "vibration"), 4.2);
}

// ---- cooling_pressure_loss ----------------------------------------------------------------------

TEST(CoolingPressureLoss, PressureDecaysTowardPointSixBarAndTheEngineRunsHotter) {
  Simulation sim = make_simulation();
  const double engine_before = truth(sim, kVessel, "ME1", "temperature");
  activate(sim, kVessel, "cooling_pressure_loss");
  run_seconds(sim, 15);
  const double early_pressure = truth(sim, kVessel, "COOL1", "pressure");
  EXPECT_GT(early_pressure, 1.2) << "gradual decay";
  EXPECT_LT(early_pressure, 2.5);
  run_seconds(sim, 120);
  EXPECT_NEAR(truth(sim, kVessel, "COOL1", "pressure"), 0.6, 0.15);
  EXPECT_GT(truth(sim, kVessel, "ME1", "temperature") - engine_before, 15.0)
      << "flow loss reduces cooling effectiveness so the engine temperature drifts up";
  EXPECT_EQ(state_of(sim, kVessel, "COOL1"), EquipmentState::kDegraded);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kDegraded);
}

TEST(CoolingPressureLoss, RecoversPressureAndTemperatureAfterClearing) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "cooling_pressure_loss");
  run_seconds(sim, 120);
  clear(sim, kVessel, "cooling_pressure_loss");
  sim.step(1s);
  EXPECT_LT(truth(sim, kVessel, "COOL1", "pressure"), 1.2) << "pressure does not jump back";
  run_seconds(sim, 600);
  EXPECT_GT(truth(sim, kVessel, "COOL1", "pressure"), 2.3);
  EXPECT_LT(truth(sim, kVessel, "ME1", "temperature"), 90.0);
  EXPECT_EQ(state_of(sim, kVessel, "COOL1"), EquipmentState::kRunning);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kRunning);
}

// ---- bilge_flooding -----------------------------------------------------------------------------

TEST(BilgeFlooding, LevelRisesAboutOneCentimetrePerSecondEvenWithThePumpOn) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "bilge_flooding");
  run_until(sim, [&] { return state_of(sim, kVessel, "BILGE1") == EquipmentState::kPumping; }, 120);
  const double level_a = truth(sim, kVessel, "BILGE1", "water_level");
  run_seconds(sim, 20);
  const double level_b = truth(sim, kVessel, "BILGE1", "water_level");
  EXPECT_GT((level_b - level_a) / 20.0, 0.7);
  EXPECT_LT((level_b - level_a) / 20.0, 1.3);
}

TEST(BilgeFlooding, DoesNotTouchTheEngineOrTheCooling) {
  Simulation sim = make_simulation();
  const double temperature_before = truth(sim, kVessel, "ME1", "temperature");
  activate(sim, kVessel, "bilge_flooding");
  run_seconds(sim, 60);
  EXPECT_LT(std::abs(truth(sim, kVessel, "ME1", "temperature") - temperature_before), 4.0);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kRunning);
  EXPECT_EQ(state_of(sim, kVessel, "COOL1"), EquipmentState::kRunning);
}

TEST(BilgeFlooding, DrainsBackToNormalAfterClearing) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "bilge_flooding");
  run_seconds(sim, 60);
  const double flooded = truth(sim, kVessel, "BILGE1", "water_level");
  ASSERT_GT(flooded, 40.0);
  clear(sim, kVessel, "bilge_flooding");
  sim.step(1s);
  EXPECT_GT(truth(sim, kVessel, "BILGE1", "water_level"), flooded - 5.0) << "no jump";
  run_seconds(sim, 400);
  EXPECT_LT(truth(sim, kVessel, "BILGE1", "water_level"), 20.0);
  EXPECT_EQ(state_of(sim, kVessel, "BILGE1"), EquipmentState::kStandby);
}

// ---- sensor scenarios ---------------------------------------------------------------------------

TEST(SensorStuck, PublishedValueFreezesWhileTheProcessContinues) {
  Simulation sim = make_simulation();
  run_seconds(sim, 5);
  activate(sim, kVessel, "sensor_stuck");
  activate(sim, kVessel, "engine_overheat");  // makes the true temperature move
  sim.step(1s);
  const double frozen = reading(sim, kVessel, "ME1", "temperature").value;
  const double true_before = truth(sim, kVessel, "ME1", "temperature");
  for (int i = 0; i < 40; ++i) {
    sim.step(1s);
    const Reading& r = reading(sim, kVessel, "ME1", "temperature");
    ASSERT_EQ(r.value, frozen);
    ASSERT_EQ(r.quality, Quality::kGood);
  }
  EXPECT_GT(truth(sim, kVessel, "ME1", "temperature") - true_before, 5.0);
  EXPECT_EQ(equipment(sim, kVessel, "ME1").sensor_health(), SensorHealth::kFault);
  // Other channels of the same machine keep moving.
  const double rpm_a = reading(sim, kVessel, "ME1", "rpm").value;
  sim.step(1s);
  EXPECT_NE(reading(sim, kVessel, "ME1", "rpm").value, rpm_a);
}

TEST(SensorOutOfRange, PublishesAnImpossibleValueWithGoodStatus) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "sensor_out_of_range");
  sim.step(1s);
  const Reading& r = reading(sim, kVessel, "COOL1", "pressure");
  EXPECT_EQ(r.value, -50.0);
  EXPECT_EQ(r.quality, Quality::kGood);
  EXPECT_LT(r.value, equipment(sim, kVessel, "COOL1").sensor("pressure").spec().plausible_min);
  EXPECT_NEAR(truth(sim, kVessel, "COOL1", "pressure"), 2.6, 0.3) << "the process itself is fine";
  EXPECT_EQ(equipment(sim, kVessel, "COOL1").sensor_health(), SensorHealth::kFault);
  EXPECT_EQ(state_of(sim, kVessel, "COOL1"), EquipmentState::kRunning);
}

TEST(SensorFailure, ReportsBadStatusOnlyOnTheTargetedChannel) {
  Simulation sim = make_simulation();
  run_seconds(sim, 3);
  const double last_good = reading(sim, kVessel, "GEN1", "power_output").value;
  activate(sim, kVessel, "sensor_failure");
  sim.step(1s);
  EXPECT_EQ(reading(sim, kVessel, "GEN1", "power_output").quality, Quality::kBadSensorFailure);
  EXPECT_TRUE(std::isfinite(reading(sim, kVessel, "GEN1", "power_output").value));
  EXPECT_NEAR(reading(sim, kVessel, "GEN1", "power_output").value, last_good, 40.0);
  EXPECT_EQ(reading(sim, kVessel, "GEN1", "load").quality, Quality::kGood);
  EXPECT_EQ(reading(sim, kVessel, "GEN1", "frequency").quality, Quality::kGood);
  EXPECT_EQ(equipment(sim, kVessel, "GEN1").sensor_health(), SensorHealth::kFault);
  EXPECT_EQ(reading(sim, kOther, "GEN1", "power_output").quality, Quality::kGood);
}

TEST(SensorScenarios, RecoveryIsUncertainForTenSecondsThenGood) {
  for (const auto& [scenario, code, key] :
       {std::tuple{"sensor_failure", "GEN1", "power_output"},
        std::tuple{"sensor_stuck", "ME1", "temperature"},
        std::tuple{"sensor_out_of_range", "COOL1", "pressure"}}) {
    SCOPED_TRACE(scenario);
    Simulation sim = make_simulation();
    activate(sim, kVessel, scenario);
    run_seconds(sim, 5);
    clear(sim, kVessel, scenario);
    int uncertain_seconds = 0;
    for (int i = 0; i < 20; ++i) {
      sim.step(1s);
      const Reading& r = reading(sim, kVessel, code, key);
      EXPECT_TRUE(std::isfinite(r.value));
      if (r.quality == Quality::kUncertain) {
        ++uncertain_seconds;
        EXPECT_EQ(equipment(sim, kVessel, code).sensor_health(), SensorHealth::kDegraded);
      }
    }
    EXPECT_GE(uncertain_seconds, 9);
    EXPECT_LE(uncertain_seconds, 10);
    EXPECT_EQ(reading(sim, kVessel, code, key).quality, Quality::kGood);
    EXPECT_EQ(equipment(sim, kVessel, code).sensor_health(), SensorHealth::kOk);
    EXPECT_NEAR(reading(sim, kVessel, code, key).value, truth(sim, kVessel, code, key), 5.0);
  }
}

TEST(SensorScenarios, AFaultCanReturnDuringRecovery) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "sensor_failure");
  run_seconds(sim, 3);
  clear(sim, kVessel, "sensor_failure");
  run_seconds(sim, 4);
  ASSERT_EQ(reading(sim, kVessel, "GEN1", "power_output").quality, Quality::kUncertain);
  activate(sim, kVessel, "sensor_failure");
  sim.step(1s);
  EXPECT_EQ(reading(sim, kVessel, "GEN1", "power_output").quality, Quality::kBadSensorFailure);
}

// ---- telemetry_interruption and opcua_outage
// ------------------------------------------------------

TEST(TelemetryInterruption, MarksTheVesselUntilItAutoClearsAfterSixtySeconds) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "telemetry_interruption");
  run_seconds(sim, 1);
  EXPECT_TRUE(sim.find_vessel(kVessel)->telemetry_interrupted());
  EXPECT_FALSE(sim.find_vessel(kOther)->telemetry_interrupted());
  run_seconds(sim, 58);
  EXPECT_TRUE(sim.find_vessel(kVessel)->telemetry_interrupted());
  run_seconds(sim, 3);
  EXPECT_FALSE(sim.find_vessel(kVessel)->telemetry_interrupted());
  EXPECT_TRUE(sim.scenarios().active().empty());
  EXPECT_EQ(sim.take_expired_scenarios().size(), 1U);
}

TEST(TelemetryInterruption, TheProcessKeepsRunningAndTheHeartbeatKeepsCounting) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "telemetry_interruption", 30);
  activate(sim, kVessel, "engine_overheat");
  const auto beats = sim.heartbeat();
  const double temperature = truth(sim, kVessel, "ME1", "temperature");
  run_seconds(sim, 25);
  EXPECT_EQ(sim.heartbeat(), beats + 25);
  EXPECT_GT(truth(sim, kVessel, "ME1", "temperature"), temperature + 3.0);
  EXPECT_TRUE(sim.find_vessel(kVessel)->telemetry_interrupted());
}

TEST(OpcuaOutage, DoesNotChangeAnyProcess) {
  Simulation reference = make_simulation();
  Simulation outage = make_simulation();
  ASSERT_TRUE(outage.scenarios().activate("", "opcua_outage", 5, outage.now()).accepted);
  for (int i = 0; i < 60; ++i) {
    reference.step(1s);
    outage.step(1s);
  }
  EXPECT_EQ(snapshot_bits(reference), snapshot_bits(outage));
  EXPECT_TRUE(outage.scenarios().active().empty());
}

// ---- general semantics
// ----------------------------------------------------------------------------

TEST(ScenarioSemantics, InitialScenariosFromTheConfigurationAreActiveAtStart) {
  FleetConfig fleet = default_fleet();
  fleet.vessels[1].initial_scenarios.push_back({"sensor_failure", 0});
  fleet.vessels[1].initial_scenarios.push_back({"bilge_flooding", 120});
  Simulation sim(fleet, 42, kStartTime);
  EXPECT_EQ(reading(sim, kOther, "GEN1", "power_output").quality, Quality::kBadSensorFailure);
  EXPECT_EQ(sim.scenarios().active().size(), 2U);
  run_seconds(sim, 60);
  EXPECT_GT(truth(sim, kOther, "BILGE1", "water_level"), 40.0);
  EXPECT_LT(truth(sim, kVessel, "BILGE1", "water_level"), 20.0);
}

TEST(ScenarioSemantics, ClearAllOfAVesselRestoresNormalOperation) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "engine_vibration");
  activate(sim, kVessel, "sensor_failure");
  activate(sim, kVessel, "bilge_flooding");
  run_seconds(sim, 40);
  EXPECT_TRUE(sim.scenarios().clear(kVessel, "").accepted);
  run_seconds(sim, 600);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kRunning);
  EXPECT_EQ(state_of(sim, kVessel, "BILGE1"), EquipmentState::kStandby);
  EXPECT_EQ(equipment(sim, kVessel, "GEN1").sensor_health(), SensorHealth::kOk);
}

TEST(ScenarioSemantics, TimedScenarioEndsAndTheProcessRecovers) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "cooling_pressure_loss", 60);
  run_seconds(sim, 59);
  EXPECT_LT(truth(sim, kVessel, "COOL1", "pressure"), 1.0);
  run_seconds(sim, 300);
  EXPECT_TRUE(sim.scenarios().active().empty());
  EXPECT_GT(truth(sim, kVessel, "COOL1", "pressure"), 2.3);
}

}  // namespace
}  // namespace seatrace::sim
