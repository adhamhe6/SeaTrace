#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include "core/scenario.hpp"
#include "test_support.hpp"

namespace seatrace::sim {
namespace {

using namespace std::chrono_literals;
using testing::kStartTime;

ScenarioManager make_manager() {
  return ScenarioManager({{"VES-001", {"ME1", "GEN1", "COOL1", "BILGE1"}},
                          {"VES-002", {"ME1", "GEN1", "COOL1", "BILGE1"}},
                          {"VES-003", {"ME1"}}});
}

TEST(ScenarioCatalogue, ListsAllNineScenariosWithTheContractDefaults) {
  EXPECT_EQ(scenario_catalogue().size(), 9U);
  for (const char* name : {"engine_overheat", "engine_vibration", "cooling_pressure_loss",
                           "bilge_flooding", "sensor_stuck", "sensor_out_of_range",
                           "sensor_failure", "telemetry_interruption", "opcua_outage"}) {
    EXPECT_NE(find_scenario(name), nullptr) << name;
  }
  EXPECT_EQ(find_scenario("nope"), nullptr);
  EXPECT_EQ(find_scenario("telemetry_interruption")->default_duration_s, 60U);
  EXPECT_EQ(find_scenario("opcua_outage")->default_duration_s, 20U);
  EXPECT_EQ(find_scenario("engine_overheat")->default_duration_s, 0U);
  EXPECT_EQ(find_scenario("sensor_out_of_range")->absurd_value, -50.0);
  EXPECT_EQ(find_scenario("sensor_stuck")->target_equipment, "ME1");
  EXPECT_EQ(find_scenario("sensor_stuck")->target_measurement, "temperature");
  EXPECT_EQ(find_scenario("sensor_failure")->target_measurement, "power_output");
}

TEST(ScenarioManager, ActivatesAKnownScenario) {
  auto manager = make_manager();
  const auto result = manager.activate("VES-001", "engine_overheat", 0, kStartTime);
  EXPECT_TRUE(result.accepted) << result.message;
  EXPECT_TRUE(manager.is_active("VES-001", ScenarioId::kEngineOverheat));
  EXPECT_FALSE(manager.is_active("VES-002", ScenarioId::kEngineOverheat));
  EXPECT_TRUE(manager.view_for("VES-001").active(ScenarioId::kEngineOverheat));
  EXPECT_FALSE(manager.view_for("VES-002").active(ScenarioId::kEngineOverheat));
  ASSERT_EQ(manager.active().size(), 1U);
  EXPECT_FALSE(manager.active()[0].ends_at.has_value());
}

TEST(ScenarioManager, RejectsUnknownVesselAndScenario) {
  auto manager = make_manager();
  auto result = manager.activate("VES-999", "engine_overheat", 0, kStartTime);
  EXPECT_FALSE(result.accepted);
  EXPECT_NE(result.message.find("unknown vessel 'VES-999'"), std::string::npos);
  result = manager.activate("VES-001", "meteor_strike", 0, kStartTime);
  EXPECT_FALSE(result.accepted);
  EXPECT_NE(result.message.find("unknown scenario 'meteor_strike'"), std::string::npos);
  result = manager.activate("", "engine_overheat", 0, kStartTime);
  EXPECT_FALSE(result.accepted);
  EXPECT_TRUE(manager.active().empty());
}

TEST(ScenarioManager, RejectsDuplicateActivation) {
  auto manager = make_manager();
  ASSERT_TRUE(manager.activate("VES-001", "bilge_flooding", 0, kStartTime).accepted);
  const auto again = manager.activate("VES-001", "bilge_flooding", 0, kStartTime + 5s);
  EXPECT_FALSE(again.accepted);
  EXPECT_NE(again.message.find("already active"), std::string::npos);
  EXPECT_EQ(manager.active().size(), 1U);
  // The same scenario on another vessel is a different activation.
  EXPECT_TRUE(manager.activate("VES-002", "bilge_flooding", 0, kStartTime).accepted);
}

TEST(ScenarioManager, RejectsScenariosWhoseTargetEquipmentIsMissing) {
  auto manager = make_manager();
  const auto result = manager.activate("VES-003", "bilge_flooding", 0, kStartTime);
  EXPECT_FALSE(result.accepted);
  EXPECT_NE(result.message.find("has no equipment 'BILGE1'"), std::string::npos);
  // Vessel-wide scenarios do not need a particular machine.
  EXPECT_TRUE(manager.activate("VES-003", "telemetry_interruption", 0, kStartTime).accepted);
}

TEST(ScenarioManager, TimedScenarioExpires) {
  auto manager = make_manager();
  ASSERT_TRUE(manager.activate("VES-001", "engine_vibration", 10, kStartTime).accepted);
  EXPECT_EQ(manager.active()[0].ends_at, kStartTime + 10s);
  EXPECT_TRUE(manager.expire(kStartTime + 9s).empty());
  EXPECT_TRUE(manager.is_active("VES-001", ScenarioId::kEngineVibration));
  const auto expired = manager.expire(kStartTime + 10s);
  ASSERT_EQ(expired.size(), 1U);
  EXPECT_EQ(expired[0].id, ScenarioId::kEngineVibration);
  EXPECT_FALSE(manager.is_active("VES-001", ScenarioId::kEngineVibration));
}

TEST(ScenarioManager, DefaultDurationAppliesWhenZeroIsRequested) {
  auto manager = make_manager();
  ASSERT_TRUE(manager.activate("VES-001", "telemetry_interruption", 0, kStartTime).accepted);
  EXPECT_EQ(manager.active()[0].ends_at, kStartTime + 60s);
  ASSERT_TRUE(manager.activate("VES-002", "telemetry_interruption", 15, kStartTime).accepted);
  EXPECT_EQ(manager.active()[1].ends_at, kStartTime + 15s);
}

TEST(ScenarioManager, ClearsOneScenario) {
  auto manager = make_manager();
  ASSERT_TRUE(manager.activate("VES-001", "engine_overheat", 0, kStartTime).accepted);
  ASSERT_TRUE(manager.activate("VES-001", "engine_vibration", 0, kStartTime).accepted);
  EXPECT_TRUE(manager.clear("VES-001", "engine_overheat").accepted);
  EXPECT_FALSE(manager.is_active("VES-001", ScenarioId::kEngineOverheat));
  EXPECT_TRUE(manager.is_active("VES-001", ScenarioId::kEngineVibration));
}

TEST(ScenarioManager, ClearRejectsUnknownAndInactive) {
  auto manager = make_manager();
  EXPECT_FALSE(manager.clear("VES-999", "engine_overheat").accepted);
  EXPECT_FALSE(manager.clear("VES-001", "meteor_strike").accepted);
  const auto inactive = manager.clear("VES-001", "engine_overheat");
  EXPECT_FALSE(inactive.accepted);
  EXPECT_NE(inactive.message.find("not active"), std::string::npos);
  EXPECT_FALSE(manager.clear("VES-999", "").accepted);
}

TEST(ScenarioManager, EmptyScenarioIdClearsEverythingOfThatVesselOnly) {
  auto manager = make_manager();
  ASSERT_TRUE(manager.activate("VES-001", "engine_overheat", 0, kStartTime).accepted);
  ASSERT_TRUE(manager.activate("VES-001", "sensor_stuck", 0, kStartTime).accepted);
  ASSERT_TRUE(manager.activate("VES-002", "engine_overheat", 0, kStartTime).accepted);
  const auto result = manager.clear("VES-001", "");
  EXPECT_TRUE(result.accepted);
  EXPECT_NE(result.message.find("cleared 2"), std::string::npos);
  ASSERT_EQ(manager.active().size(), 1U);
  EXPECT_EQ(manager.active()[0].vessel_id, "VES-002");
  // Idempotent when nothing is active.
  EXPECT_TRUE(manager.clear("VES-001", "").accepted);
}

TEST(ScenarioManager, ResetClearsAll) {
  auto manager = make_manager();
  ASSERT_TRUE(manager.activate("VES-001", "engine_overheat", 0, kStartTime).accepted);
  ASSERT_TRUE(manager.activate("VES-002", "bilge_flooding", 0, kStartTime).accepted);
  ASSERT_TRUE(manager.activate("", "opcua_outage", 5, kStartTime).accepted);
  const auto result = manager.reset();
  EXPECT_TRUE(result.accepted);
  EXPECT_NE(result.message.find("3"), std::string::npos);
  EXPECT_TRUE(manager.active().empty());
  EXPECT_EQ(manager.active_json(), "[]");
  EXPECT_FALSE(manager.listener_down(kStartTime + 2s));
}

TEST(ScenarioManager, OutageIsServerWideAndIgnoresTheVesselId) {
  auto manager = make_manager();
  EXPECT_TRUE(manager.activate("ignored", "opcua_outage", 0, kStartTime).accepted);
  EXPECT_EQ(manager.active()[0].vessel_id, "");
  EXPECT_FALSE(manager.activate("", "opcua_outage", 5, kStartTime).accepted);  // duplicate
  EXPECT_TRUE(manager.clear("", "opcua_outage").accepted);
}

TEST(ScenarioManager, OutageListenerWindowStartsAfterOneSecondAndLastsTheDuration) {
  auto manager = make_manager();
  ASSERT_TRUE(manager.activate("", "opcua_outage", 20, kStartTime).accepted);
  EXPECT_FALSE(manager.listener_down(kStartTime));
  EXPECT_FALSE(manager.listener_down(kStartTime + 999ms));
  EXPECT_TRUE(manager.listener_down(kStartTime + 1s));
  EXPECT_TRUE(manager.listener_down(kStartTime + 20s));
  EXPECT_TRUE(manager.listener_down(kStartTime + 20999ms));
  EXPECT_EQ(manager.expire(kStartTime + 21s).size(), 1U);
  EXPECT_FALSE(manager.listener_down(kStartTime + 21s));
}

TEST(ScenarioManager, OutageDefaultsToTwentySecondsAndIsCappedAt120) {
  auto manager = make_manager();
  ASSERT_TRUE(manager.activate("", "opcua_outage", 0, kStartTime).accepted);
  EXPECT_EQ(manager.active()[0].ends_at, kStartTime + 21s);
  manager.reset();
  EXPECT_TRUE(manager.activate("", "opcua_outage", 120, kStartTime).accepted);
  manager.reset();
  const auto too_long = manager.activate("", "opcua_outage", 121, kStartTime);
  EXPECT_FALSE(too_long.accepted);
  EXPECT_NE(too_long.message.find("120"), std::string::npos);
}

TEST(ScenarioManager, ActiveScenariosJsonMatchesTheContract) {
  auto manager = make_manager();
  EXPECT_EQ(manager.active_json(), "[]");
  ASSERT_TRUE(manager.activate("VES-001", "engine_overheat", 0, kStartTime).accepted);
  ASSERT_TRUE(manager.activate("VES-002", "telemetry_interruption", 0, kStartTime).accepted);
  // Exact key order and formatting of the contract example.
  EXPECT_EQ(manager.active_json(),
            R"([{"scenario_id":"engine_overheat","vessel_id":"VES-001","started_at":)"
            R"("2026-01-01T12:00:00.000Z","ends_at":null},)"
            R"({"scenario_id":"telemetry_interruption","vessel_id":"VES-002","started_at":)"
            R"("2026-01-01T12:00:00.000Z","ends_at":"2026-01-01T12:01:00.000Z"}])");
  const auto parsed = nlohmann::json::parse(manager.active_json());
  ASSERT_EQ(parsed.size(), 2U);
  EXPECT_TRUE(parsed[0]["ends_at"].is_null());
}

TEST(Iso8601, FormatsMilliseconds) {
  EXPECT_EQ(format_iso8601(kStartTime), "2026-01-01T12:00:00.000Z");
  EXPECT_EQ(format_iso8601(kStartTime + 1234ms), "2026-01-01T12:00:01.234Z");
  EXPECT_EQ(format_iso8601(SimTime{}), "1970-01-01T00:00:00.000Z");
}

}  // namespace
}  // namespace seatrace::sim
