#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <nlohmann/json.hpp>

#include "opcua_test_support.hpp"

namespace seatrace::sim {
namespace {

using namespace testing;
using ::testing::Contains;
using ::testing::UnorderedElementsAre;
using namespace std::chrono_literals;

std::vector<std::string> names(const std::vector<Child>& children) {
  std::vector<std::string> result;
  for (const Child& c : children) result.push_back(c.name);
  return result;
}

class OpcUaServerTest : public ::testing::Test {
 protected:
  void SetUp() override {
    simulator = std::make_unique<RunningSimulator>();
    ASSERT_EQ(anonymous.connect(simulator->endpoint()), UA_STATUSCODE_GOOD);
  }

  Client& control() {
    if (!control_connected) {
      EXPECT_EQ(control_client.connect(simulator->endpoint(), kControlUser, kControlPassword),
                UA_STATUSCODE_GOOD);
      control_connected = true;
    }
    return control_client;
  }

  std::unique_ptr<RunningSimulator> simulator;
  Client anonymous;
  Client control_client;
  bool control_connected = false;
};

// ---- address space ----------------------------------------------------------------------------

TEST_F(OpcUaServerTest, NamespaceUriIsRegistered) { EXPECT_NE(anonymous.namespace_index(), 0); }

TEST_F(OpcUaServerTest, BrowseExposesTheDocumentedHierarchy) {
  const auto ns = anonymous.namespace_index();
  const auto top = anonymous.children_of(UA_NODEID_NUMERIC(0, UA_NS0ID_OBJECTSFOLDER));
  EXPECT_THAT(names(top), Contains("SeaTrace"));

  EXPECT_THAT(names(anonymous.children("SeaTrace")), UnorderedElementsAre("Simulator", "Vessels"));
  EXPECT_THAT(names(anonymous.children("Simulator")),
              UnorderedElementsAre("Notice", "Seed", "Heartbeat", "ActiveScenarios",
                                   "ActivateScenario", "ClearScenario", "ResetScenarios"));
  EXPECT_THAT(names(anonymous.children("Vessels")), UnorderedElementsAre("VES-001", "VES-002"));
  EXPECT_THAT(names(anonymous.children("VES-001")),
              UnorderedElementsAre("VesselId", "Name", "ME1", "GEN1", "COOL1", "BILGE1"));
  EXPECT_THAT(names(anonymous.children("VES-001.ME1")),
              UnorderedElementsAre("EquipmentType", "State", "SensorHealth", "Rpm", "Temperature",
                                   "Vibration", "Load"));
  EXPECT_THAT(names(anonymous.children("VES-001.GEN1")),
              UnorderedElementsAre("EquipmentType", "State", "SensorHealth", "PowerOutput", "Load",
                                   "Frequency"));
  EXPECT_THAT(
      names(anonymous.children("VES-002.COOL1")),
      UnorderedElementsAre("EquipmentType", "State", "SensorHealth", "Pressure", "Temperature"));
  EXPECT_THAT(names(anonymous.children("VES-002.BILGE1")),
              UnorderedElementsAre("EquipmentType", "State", "SensorHealth", "WaterLevel"));
  EXPECT_THAT(names(anonymous.children("VES-001.ME1.Temperature")), UnorderedElementsAre("Unit"));
  (void)ns;
}

TEST_F(OpcUaServerTest, StringNodeIdsFollowTheDottedPathConvention) {
  for (const char* id :
       {"VES-001.ME1.Temperature", "VES-002.GEN1.PowerOutput", "VES-001.BILGE1.WaterLevel",
        "VES-001.ME1.State", "VES-001.COOL1.SensorHealth", "VES-002.VesselId",
        "Simulator.Heartbeat", "Simulator.ActivateScenario", "VES-001.ME1.Temperature.Unit"}) {
    EXPECT_EQ(anonymous.read(id, UA_ATTRIBUTEID_BROWSENAME).service_status, UA_STATUSCODE_GOOD)
        << id;
  }
}

TEST_F(OpcUaServerTest, DisplayNamesCarryTheVesselAndEquipmentNames) {
  DataValue vessel = anonymous.read("VES-001", UA_ATTRIBUTEID_DISPLAYNAME);
  ASSERT_EQ(vessel.service_status, UA_STATUSCODE_GOOD);
  const auto* text = static_cast<UA_LocalizedText*>(vessel.raw().value.data);
  EXPECT_EQ(std::string(reinterpret_cast<char*>(text->text.data), text->text.length),
            "MV Aurora Tide");
  EXPECT_EQ(anonymous.read("VES-001.VesselId").as_string(), "VES-001");
  EXPECT_EQ(anonymous.read("VES-002.Name").as_string(), "MV Baltic Meridian");
  EXPECT_EQ(anonymous.read("VES-001.ME1.EquipmentType").as_string(), "MainEngine");
  EXPECT_EQ(anonymous.read("VES-001.BILGE1.EquipmentType").as_string(), "BilgeSystem");
}

TEST_F(OpcUaServerTest, MeasurementsAreDoublesWithUnitsAndGoodStatusAndTimestamps) {
  struct Expectation {
    const char* id;
    const char* unit;
    double min;
    double max;
  };
  for (const Expectation& e : {Expectation{"VES-001.ME1.Rpm", "rpm", 85, 110},
                               Expectation{"VES-001.ME1.Temperature", "°C", 75, 92},
                               Expectation{"VES-001.ME1.Vibration", "mm/s", 1.5, 4.5},
                               Expectation{"VES-001.ME1.Load", "%", 55, 85},
                               Expectation{"VES-001.GEN1.PowerOutput", "kW", 280, 520},
                               Expectation{"VES-001.GEN1.Load", "%", 45, 85},
                               Expectation{"VES-001.GEN1.Frequency", "Hz", 49.6, 50.4},
                               Expectation{"VES-001.COOL1.Pressure", "bar", 2.0, 3.2},
                               Expectation{"VES-001.COOL1.Temperature", "°C", 55, 75},
                               Expectation{"VES-001.BILGE1.WaterLevel", "cm", 0, 25}}) {
    SCOPED_TRACE(e.id);
    const DataValue value = anonymous.read(e.id);
    ASSERT_EQ(value.service_status, UA_STATUSCODE_GOOD);
    ASSERT_TRUE(value.is_double());
    EXPECT_EQ(value.status(), UA_STATUSCODE_GOOD);
    EXPECT_TRUE(std::isfinite(value.as_double()));
    EXPECT_GE(value.as_double(), e.min);
    EXPECT_LE(value.as_double(), e.max);
    EXPECT_TRUE(value.has_source_timestamp());
    EXPECT_TRUE(value.has_server_timestamp());
    EXPECT_EQ(anonymous.read(std::string(e.id) + ".Unit").as_string(), e.unit);
  }
}

TEST_F(OpcUaServerTest, StateAndSensorHealthAreStrings) {
  EXPECT_EQ(anonymous.read("VES-001.ME1.State").as_string(), "RUNNING");
  EXPECT_EQ(anonymous.read("VES-001.GEN1.State").as_string(), "RUNNING");
  EXPECT_EQ(anonymous.read("VES-001.COOL1.State").as_string(), "RUNNING");
  EXPECT_EQ(anonymous.read("VES-001.BILGE1.State").as_string(), "STANDBY");
  EXPECT_EQ(anonymous.read("VES-001.ME1.SensorHealth").as_string(), "OK");
  EXPECT_TRUE(anonymous.read("VES-001.ME1.State").has_source_timestamp());
}

TEST_F(OpcUaServerTest, SimulatorObjectPublishesNoticeSeedHeartbeatAndScenarios) {
  EXPECT_THAT(anonymous.read("Simulator.Notice").as_string(),
              ::testing::StartsWith("SIMULATED DATA"));
  EXPECT_EQ(anonymous.read("Simulator.Seed").as_uint64(), 42U);
  EXPECT_EQ(anonymous.read("Simulator.ActiveScenarios").as_string(), "[]");
  const std::uint64_t first = anonymous.read("Simulator.Heartbeat").as_uint64();
  EXPECT_TRUE(
      poll_until([&] { return anonymous.read("Simulator.Heartbeat").as_uint64() >= first + 3; }));
}

TEST_F(OpcUaServerTest, MeasurementsAreReadOnlyAndNotWritableByClients) {
  UA_WriteValue item;
  UA_WriteValue_init(&item);
  item.nodeId = anonymous.node("VES-001.ME1.Temperature");
  item.attributeId = UA_ATTRIBUTEID_VALUE;
  item.value.hasValue = true;
  double v = 1.0;
  UA_Variant_setScalar(&item.value.value, &v, &UA_TYPES[UA_TYPES_DOUBLE]);
  UA_WriteRequest request;
  UA_WriteRequest_init(&request);
  request.nodesToWrite = &item;
  request.nodesToWriteSize = 1;
  UA_WriteResponse response = UA_Client_Service_write(anonymous.raw(), request);
  ASSERT_EQ(response.resultsSize, 1U);
  EXPECT_NE(response.results[0], UA_STATUSCODE_GOOD);
  UA_WriteResponse_clear(&response);
  EXPECT_NE(anonymous.read("VES-001.ME1.Temperature").as_double(), 1.0);
}

TEST_F(OpcUaServerTest, SourceTimestampsAdvanceWithTheSimulationTick) {
  const DataValue first = anonymous.read("VES-001.ME1.Rpm");
  ASSERT_EQ(first.service_status, UA_STATUSCODE_GOOD);
  const UA_DateTime t0 = first.source_timestamp();
  UA_DateTime t1 = t0;
  ASSERT_TRUE(poll_until([&] {
    t1 = anonymous.read("VES-001.ME1.Rpm").source_timestamp();
    return t1 > t0;
  }));
  const auto step_ms = (t1 - t0) / UA_DATETIME_MSEC;
  EXPECT_GE(step_ms, 100);
  EXPECT_LE(step_ms, 300);
  // Source time is simulation time: close to the wall clock.
  const auto now_unix_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                               std::chrono::system_clock::now().time_since_epoch())
                               .count();
  const auto source_unix_ms = (t1 - UA_DATETIME_UNIX_EPOCH) / UA_DATETIME_MSEC;
  EXPECT_LT(std::abs(now_unix_ms - source_unix_ms), 2000);
}

// ---- control methods -------------------------------------------------------------------------

TEST_F(OpcUaServerTest, MethodsHaveTheDocumentedSignatures) {
  const auto method_children = anonymous.children("Simulator.ActivateScenario");
  EXPECT_THAT(names(method_children), UnorderedElementsAre("InputArguments", "OutputArguments"));
  EXPECT_THAT(names(anonymous.children("Simulator.ClearScenario")),
              UnorderedElementsAre("InputArguments", "OutputArguments"));
  EXPECT_THAT(names(anonymous.children("Simulator.ResetScenarios")),
              UnorderedElementsAre("OutputArguments"));

  // Read the argument definitions through the numeric NodeIds returned by the browse.
  const std::string method_id = "Simulator.ActivateScenario";
  UA_BrowseDescription d;
  UA_BrowseDescription_init(&d);
  d.nodeId = anonymous.node(method_id);
  d.browseDirection = UA_BROWSEDIRECTION_FORWARD;
  d.referenceTypeId = UA_NODEID_NUMERIC(0, UA_NS0ID_HASPROPERTY);
  d.includeSubtypes = true;
  d.resultMask = UA_BROWSERESULTMASK_ALL;
  UA_BrowseRequest request;
  UA_BrowseRequest_init(&request);
  request.nodesToBrowse = &d;
  request.nodesToBrowseSize = 1;
  UA_BrowseResponse response = UA_Client_Service_browse(anonymous.raw(), request);
  ASSERT_EQ(response.resultsSize, 1U);
  std::vector<std::string> signature;
  for (size_t i = 0; i < response.results[0].referencesSize; ++i) {
    const UA_ReferenceDescription& ref = response.results[0].references[i];
    UA_Variant value;
    UA_Variant_init(&value);
    ASSERT_EQ(UA_Client_readValueAttribute(anonymous.raw(), ref.nodeId.nodeId, &value),
              UA_STATUSCODE_GOOD);
    const std::string property(reinterpret_cast<const char*>(ref.browseName.name.data),
                               ref.browseName.name.length);
    for (size_t k = 0; k < value.arrayLength; ++k) {
      const auto& argument = static_cast<UA_Argument*>(value.data)[k];
      signature.push_back(
          property + ":" +
          std::string(reinterpret_cast<char*>(argument.name.data), argument.name.length) + ":" +
          std::to_string(argument.dataType.identifier.numeric));
    }
    UA_Variant_clear(&value);
  }
  UA_BrowseResponse_clear(&response);
  EXPECT_THAT(signature,
              UnorderedElementsAre("InputArguments:vesselId:12", "InputArguments:scenarioId:12",
                                   "InputArguments:durationSeconds:7", "OutputArguments:accepted:1",
                                   "OutputArguments:message:12"));
}

TEST_F(OpcUaServerTest, ControlAccountCanActivateAndClearScenarios) {
  Client& c = control();
  const CallResult activated = c.activate("VES-001", "engine_vibration");
  ASSERT_EQ(activated.status, UA_STATUSCODE_GOOD);
  EXPECT_TRUE(activated.accepted) << activated.message;

  ASSERT_TRUE(
      poll_until([&] { return anonymous.read("Simulator.ActiveScenarios").as_string() != "[]"; }));
  const auto json = nlohmann::json::parse(anonymous.read("Simulator.ActiveScenarios").as_string());
  ASSERT_EQ(json.size(), 1U);
  EXPECT_EQ(json[0]["scenario_id"], "engine_vibration");
  EXPECT_EQ(json[0]["vessel_id"], "VES-001");
  EXPECT_TRUE(json[0]["ends_at"].is_null());
  EXPECT_TRUE(json[0]["started_at"].get<std::string>().ends_with("Z"));

  const CallResult cleared = c.clear("VES-001", "engine_vibration");
  EXPECT_TRUE(cleared.accepted) << cleared.message;
  EXPECT_TRUE(
      poll_until([&] { return anonymous.read("Simulator.ActiveScenarios").as_string() == "[]"; }));
}

TEST_F(OpcUaServerTest, MethodsRejectUnknownDuplicateAndInvalidRequestsWithoutFailingTheCall) {
  Client& c = control();
  auto result = c.activate("VES-999", "engine_overheat");
  EXPECT_EQ(result.status, UA_STATUSCODE_GOOD);
  EXPECT_FALSE(result.accepted);
  EXPECT_THAT(result.message, ::testing::HasSubstr("unknown vessel"));

  result = c.activate("VES-001", "no_such_scenario");
  EXPECT_EQ(result.status, UA_STATUSCODE_GOOD);
  EXPECT_FALSE(result.accepted);
  EXPECT_THAT(result.message, ::testing::HasSubstr("unknown scenario"));

  ASSERT_TRUE(c.activate("VES-001", "bilge_flooding").accepted);
  result = c.activate("VES-001", "bilge_flooding");
  EXPECT_EQ(result.status, UA_STATUSCODE_GOOD);
  EXPECT_FALSE(result.accepted);
  EXPECT_THAT(result.message, ::testing::HasSubstr("already active"));

  result = c.clear("VES-002", "bilge_flooding");
  EXPECT_FALSE(result.accepted);
  result = c.clear("VES-999", "");
  EXPECT_FALSE(result.accepted);

  const CallResult reset = c.reset();
  EXPECT_EQ(reset.status, UA_STATUSCODE_GOOD);
  EXPECT_TRUE(reset.accepted);
  EXPECT_TRUE(
      poll_until([&] { return anonymous.read("Simulator.ActiveScenarios").as_string() == "[]"; }));
}

TEST_F(OpcUaServerTest, MethodCallsWithWrongArgumentsFailAtTheProtocolLevel) {
  Client& c = control();
  // Wrong argument type: Int64 instead of UInt32.
  EXPECT_EQ(c.call("ActivateScenario",
                   {Client::text("VES-001"), Client::text("engine_overheat"), Client::int64(0)})
                .status,
            UA_STATUSCODE_BADINVALIDARGUMENT);
  EXPECT_EQ(c.call("ActivateScenario", {Client::text("VES-001")}).status,
            UA_STATUSCODE_BADARGUMENTSMISSING);
  EXPECT_EQ(
      c.call("ClearScenario", {Client::text("a"), Client::text("b"), Client::text("c")}).status,
      UA_STATUSCODE_BADTOOMANYARGUMENTS);
  EXPECT_TRUE(c.reset().accepted);
}

TEST_F(OpcUaServerTest, AnonymousClientsMayReadButNotCallMethods) {
  EXPECT_EQ(anonymous.activate("VES-001", "engine_overheat").status,
            UA_STATUSCODE_BADUSERACCESSDENIED);
  EXPECT_EQ(anonymous.clear("VES-001", "").status, UA_STATUSCODE_BADUSERACCESSDENIED);
  EXPECT_EQ(anonymous.reset().status, UA_STATUSCODE_BADUSERACCESSDENIED);
  EXPECT_EQ(anonymous.read("Simulator.ActiveScenarios").as_string(), "[]")
      << "nothing was activated";
  EXPECT_EQ(anonymous.read("VES-001.ME1.Temperature").service_status, UA_STATUSCODE_GOOD);
}

TEST_F(OpcUaServerTest, UserExecutableAttributeReflectsTheAccount) {
  const DataValue anon =
      anonymous.read("Simulator.ActivateScenario", UA_ATTRIBUTEID_USEREXECUTABLE);
  const DataValue ctl = control().read("Simulator.ActivateScenario", UA_ATTRIBUTEID_USEREXECUTABLE);
  ASSERT_EQ(anon.service_status, UA_STATUSCODE_GOOD);
  EXPECT_FALSE(*static_cast<UA_Boolean*>(anon.raw().value.data));
  EXPECT_TRUE(*static_cast<UA_Boolean*>(ctl.raw().value.data));
}

TEST_F(OpcUaServerTest, WrongPasswordOrUnknownUserCannotLogIn) {
  Client wrong_password;
  EXPECT_NE(wrong_password.connect(simulator->endpoint(), kControlUser, "not-the-password"),
            UA_STATUSCODE_GOOD);
  Client wrong_user;
  EXPECT_NE(wrong_user.connect(simulator->endpoint(), "someone", kControlPassword),
            UA_STATUSCODE_GOOD);
  Client empty_password;
  EXPECT_NE(empty_password.connect(simulator->endpoint(), kControlUser, ""), UA_STATUSCODE_GOOD);
}

TEST_F(OpcUaServerTest, ClientsCannotModifyTheAddressSpace) {
  UA_AddNodesItem item;
  UA_AddNodesItem_init(&item);
  item.parentNodeId.nodeId = UA_NODEID_NUMERIC(0, UA_NS0ID_OBJECTSFOLDER);
  item.referenceTypeId = UA_NODEID_NUMERIC(0, UA_NS0ID_ORGANIZES);
  item.browseName = UA_QUALIFIEDNAME(1, const_cast<char*>("Intruder"));
  item.nodeClass = UA_NODECLASS_OBJECT;
  item.typeDefinition.nodeId = UA_NODEID_NUMERIC(0, UA_NS0ID_BASEOBJECTTYPE);
  UA_ObjectAttributes attributes = UA_ObjectAttributes_default;
  UA_ExtensionObject_setValueNoDelete(&item.nodeAttributes, &attributes,
                                      &UA_TYPES[UA_TYPES_OBJECTATTRIBUTES]);
  UA_AddNodesRequest request;
  UA_AddNodesRequest_init(&request);
  request.nodesToAdd = &item;
  request.nodesToAddSize = 1;
  for (Client* client : {&anonymous, &control()}) {
    UA_AddNodesResponse response = UA_Client_Service_addNodes(client->raw(), request);
    ASSERT_EQ(response.resultsSize, 1U);
    EXPECT_NE(response.results[0].statusCode, UA_STATUSCODE_GOOD);
    UA_AddNodesResponse_clear(&response);
  }
}

// ---- scenarios as seen by OPC UA clients -------------------------------------------------------

TEST_F(OpcUaServerTest, SensorFailurePublishesBadSensorFailureStatus) {
  ASSERT_TRUE(control().activate("VES-001", "sensor_failure").accepted);
  ASSERT_TRUE(poll_until([&] {
    return anonymous.read("VES-001.GEN1.PowerOutput").status() == UA_STATUSCODE_BADSENSORFAILURE;
  }));
  const DataValue bad = anonymous.read("VES-001.GEN1.PowerOutput");
  EXPECT_EQ(bad.status(), 0x808C0000U) << "BadSensorFailure";
  EXPECT_TRUE(std::isfinite(bad.as_double()));
  EXPECT_EQ(anonymous.read("VES-001.GEN1.SensorHealth").as_string(), "FAULT");
  EXPECT_EQ(anonymous.read("VES-001.GEN1.Load").status(), UA_STATUSCODE_GOOD);
  EXPECT_EQ(anonymous.read("VES-002.GEN1.PowerOutput").status(), UA_STATUSCODE_GOOD);

  ASSERT_TRUE(control().clear("VES-001", "sensor_failure").accepted);
  ASSERT_TRUE(poll_until([&] {
    return anonymous.read("VES-001.GEN1.PowerOutput").status() ==
           UA_STATUSCODE_UNCERTAINSENSORNOTACCURATE;
  }));
  EXPECT_EQ(anonymous.read("VES-001.GEN1.PowerOutput").status(), 0x40930000U)
      << "UncertainSensorNotAccurate";
  ASSERT_TRUE(poll_until(
      [&] { return anonymous.read("VES-001.GEN1.PowerOutput").status() == UA_STATUSCODE_GOOD; },
      15s));
}

TEST_F(OpcUaServerTest, SensorOutOfRangePublishesMinusFiftyBarWithGoodStatus) {
  ASSERT_TRUE(control().activate("VES-002", "sensor_out_of_range").accepted);
  ASSERT_TRUE(
      poll_until([&] { return anonymous.read("VES-002.COOL1.Pressure").as_double() == -50.0; }));
  const DataValue value = anonymous.read("VES-002.COOL1.Pressure");
  EXPECT_EQ(value.status(), UA_STATUSCODE_GOOD);
  EXPECT_EQ(anonymous.read("VES-001.COOL1.Pressure").as_double() > 0, true);
}

TEST_F(OpcUaServerTest, StuckSensorKeepsItsValueWhileTheTimestampAdvances) {
  ASSERT_TRUE(control().activate("VES-001", "sensor_stuck").accepted);
  // Wait for the freeze to take effect, then compare consecutive reads.
  DataValue a;
  DataValue b;
  ASSERT_TRUE(poll_until([&] {
    a = anonymous.read("VES-001.ME1.Temperature");
    b = anonymous.read("VES-001.ME1.Temperature");
    return a.source_timestamp() == b.source_timestamp();  // both reads inside one tick
  }));
  const double frozen = a.as_double();
  const UA_DateTime t0 = a.source_timestamp();
  UA_DateTime t1 = t0;
  ASSERT_TRUE(poll_until([&] {
    const DataValue now = anonymous.read("VES-001.ME1.Temperature");
    t1 = now.source_timestamp();
    return t1 >= t0 + 500 * UA_DATETIME_MSEC;
  }));
  const DataValue later = anonymous.read("VES-001.ME1.Temperature");
  EXPECT_EQ(later.as_double(), frozen);
  EXPECT_EQ(later.status(), UA_STATUSCODE_GOOD);
  EXPECT_GT(later.source_timestamp(), t0);
}

TEST_F(OpcUaServerTest, TelemetryInterruptionFreezesValuesAndTimestampsButNotTheHeartbeat) {
  ASSERT_TRUE(control().activate("VES-001", "telemetry_interruption", 3).accepted);
  // Let the interruption settle in (a tick may be in flight), then record the frozen state.
  std::this_thread::sleep_for(300ms);
  const DataValue frozen = anonymous.read("VES-001.ME1.Temperature");
  const DataValue frozen_state = anonymous.read("VES-001.ME1.State");
  const std::uint64_t beat = anonymous.read("Simulator.Heartbeat").as_uint64();
  const DataValue other_before = anonymous.read("VES-002.ME1.Temperature");

  ASSERT_TRUE(
      poll_until([&] { return anonymous.read("Simulator.Heartbeat").as_uint64() >= beat + 10; }));
  const DataValue still = anonymous.read("VES-001.ME1.Temperature");
  EXPECT_EQ(still.source_timestamp(), frozen.source_timestamp())
      << "source timestamp must stop advancing";
  EXPECT_EQ(still.as_double(), frozen.as_double());
  EXPECT_EQ(still.status(), UA_STATUSCODE_GOOD);
  EXPECT_EQ(anonymous.read("VES-001.ME1.State").source_timestamp(),
            frozen_state.source_timestamp());
  EXPECT_GT(anonymous.read("VES-002.ME1.Temperature").source_timestamp(),
            other_before.source_timestamp())
      << "other vessels keep publishing";

  // The scenario ends by itself (3 s) and publishing resumes.
  ASSERT_TRUE(poll_until(
      [&] {
        return anonymous.read("VES-001.ME1.Temperature").source_timestamp() >
               frozen.source_timestamp();
      },
      10s));
}

TEST_F(OpcUaServerTest, EngineOverheatRaisesTheTemperatureOverTime) {
  const double before = anonymous.read("VES-002.ME1.Temperature").as_double();
  ASSERT_TRUE(control().activate("VES-002", "engine_overheat").accepted);
  // Ticks run in real time, so the rise is paced by physical time (about 0.3 K/s at first).
  ASSERT_TRUE(poll_until(
      [&] { return anonymous.read("VES-002.ME1.Temperature").as_double() > before + 3.0; }, 60s,
      100ms));
  EXPECT_THAT(anonymous.read("VES-002.ME1.State").as_string(),
              ::testing::AnyOf("RUNNING", "DEGRADED"));
  EXPECT_EQ(anonymous.read("VES-002.COOL1.Pressure").status(), UA_STATUSCODE_GOOD);
}

// ---- subscriptions ---------------------------------------------------------------------------

TEST_F(OpcUaServerTest, SubscriptionsDeliverADataChangePerTickEvenForUnchangedValues) {
  ASSERT_TRUE(control().activate("VES-001", "sensor_stuck").accepted);
  ASSERT_TRUE(poll_until(
      [&] { return anonymous.read("VES-001.ME1.SensorHealth").as_string() == "FAULT"; }));

  const std::vector<Notification>* sink = anonymous.subscribe("VES-001.ME1.Temperature");
  ASSERT_NE(sink, nullptr);
  const std::vector<Notification>& notifications = *sink;
  ASSERT_TRUE(anonymous.pump_until([&] { return notifications.size() >= 10; }, 15s))
      << "got " << notifications.size() << " notifications";

  // The value is frozen, so only the advancing source timestamp can have triggered them.
  const auto first = notifications.front().value;
  for (const Notification& n : notifications) {
    EXPECT_EQ(n.value, first);
    EXPECT_EQ(n.status, UA_STATUSCODE_GOOD);
  }
  for (std::size_t i = 1; i < notifications.size(); ++i) {
    EXPECT_GT(notifications[i].source_timestamp, notifications[i - 1].source_timestamp);
  }
  const auto span_ms = (notifications.back().source_timestamp - notifications[1].source_timestamp) /
                       UA_DATETIME_MSEC;
  EXPECT_NEAR(static_cast<double>(span_ms) / static_cast<double>(notifications.size() - 2), 100.0,
              25.0)
      << "one notification per 100 ms tick";
}

TEST_F(OpcUaServerTest, SubscriptionReportsStatusChanges) {
  const std::vector<Notification>* sink = anonymous.subscribe("VES-001.GEN1.PowerOutput");
  ASSERT_NE(sink, nullptr);
  const std::vector<Notification>& notifications = *sink;
  ASSERT_TRUE(anonymous.pump_until([&] { return notifications.size() >= 3; }));
  ASSERT_TRUE(control().activate("VES-001", "sensor_failure").accepted);
  ASSERT_TRUE(anonymous.pump_until([&] {
    return std::ranges::any_of(notifications, [](const Notification& n) {
      return n.status == UA_STATUSCODE_BADSENSORFAILURE;
    });
  }));
}

// ---- outage ----------------------------------------------------------------------------------

TEST_F(OpcUaServerTest, OutageDropsClientsAndTheServerComesBackWithFreshSubscriptions) {
  Client& c = control();
  const std::vector<Notification>* before = c.subscribe("VES-001.ME1.Rpm");
  ASSERT_NE(before, nullptr);
  ASSERT_TRUE(c.pump_until([&] { return before->size() >= 3; }));
  const std::uint64_t beat_before = anonymous.read("Simulator.Heartbeat").as_uint64();

  const auto result = c.activate("", "opcua_outage", 3);
  ASSERT_EQ(result.status, UA_STATUSCODE_GOOD);
  ASSERT_TRUE(result.accepted) << result.message;

  // The listener goes down about a second later: existing connections break.
  ASSERT_TRUE(c.pump_until([&] { return !c.session_active(); }, 10s))
      << "client never lost the connection";
  Client probe;
  EXPECT_NE(probe.connect(simulator->endpoint()), UA_STATUSCODE_GOOD)
      << "no new connections during the outage";

  // ... and returns after the configured duration.
  std::unique_ptr<Client> reconnected;
  ASSERT_TRUE(poll_until(
      [&] {
        auto attempt = std::make_unique<Client>();
        if (attempt->connect(simulator->endpoint()) != UA_STATUSCODE_GOOD) return false;
        reconnected = std::move(attempt);
        return true;
      },
      15s, 100ms))
      << "server did not come back";
  Client& after = *reconnected;

  // The simulation kept running during the outage: the heartbeat gap covers at least the outage.
  const std::uint64_t beat_after = after.read("Simulator.Heartbeat").as_uint64();
  EXPECT_GE(beat_after, beat_before + 30) << "3 s outage at 10 ticks/s";
  EXPECT_EQ(after.read("Simulator.ActiveScenarios").as_string(), "[]")
      << "the outage scenario ended";
  EXPECT_EQ(after.read("VES-001.ME1.Rpm").status(), UA_STATUSCODE_GOOD);

  // A new subscription works after the restart.
  const std::vector<Notification>* notifications = after.subscribe("VES-001.ME1.Rpm");
  ASSERT_NE(notifications, nullptr);
  ASSERT_TRUE(after.pump_until([&] { return notifications->size() >= 5; }, 15s));

  // The control account can log in again as well.
  Client control_again;
  ASSERT_EQ(control_again.connect(simulator->endpoint(), kControlUser, kControlPassword),
            UA_STATUSCODE_GOOD);
  EXPECT_TRUE(control_again.reset().accepted);
}

TEST_F(OpcUaServerTest, OutageCanBeCancelledBeforeItStarts) {
  Client& c = control();
  ASSERT_TRUE(c.activate("", "opcua_outage", 30).accepted);
  EXPECT_TRUE(c.clear("", "opcua_outage").accepted);
  std::this_thread::sleep_for(1500ms);
  EXPECT_TRUE(c.session_active());
  EXPECT_EQ(c.read("Simulator.Heartbeat").service_status, UA_STATUSCODE_GOOD);
}

TEST_F(OpcUaServerTest, OutageDurationIsValidated) {
  const auto result = control().activate("", "opcua_outage", 121);
  EXPECT_EQ(result.status, UA_STATUSCODE_GOOD);
  EXPECT_FALSE(result.accepted);
}

// ---- reproducibility over OPC UA -------------------------------------------------------------

TEST(OpcUaSeed, SeedIsPublishedAndConfigurable) {
  SimulatorOptions options;
  options.seed = 1234;
  RunningSimulator simulator(std::move(options));
  Client client;
  ASSERT_EQ(client.connect(simulator.endpoint()), UA_STATUSCODE_GOOD);
  EXPECT_EQ(client.read("Simulator.Seed").as_uint64(), 1234U);
}

TEST(OpcUaFleet, InitialScenariosAndStatesComeFromTheConfiguration) {
  FleetConfig fleet = default_fleet();
  fleet.vessels[1].initial_scenarios.push_back({"sensor_failure", 0});
  fleet.vessels[1].equipment[0].initial_state = EquipmentState::kStopped;
  SimulatorOptions options;
  options.fleet = fleet;
  RunningSimulator simulator(std::move(options));
  Client client;
  ASSERT_EQ(client.connect(simulator.endpoint()), UA_STATUSCODE_GOOD);
  EXPECT_EQ(client.read("VES-002.ME1.State").as_string(), "STOPPED");
  EXPECT_EQ(client.read("VES-002.ME1.Rpm").as_double(), 0.0);
  EXPECT_EQ(client.read("VES-002.GEN1.PowerOutput").status(), UA_STATUSCODE_BADSENSORFAILURE);
  EXPECT_EQ(client.read("VES-001.ME1.State").as_string(), "RUNNING");
  const auto scenarios =
      nlohmann::json::parse(client.read("Simulator.ActiveScenarios").as_string());
  ASSERT_EQ(scenarios.size(), 1U);
  EXPECT_EQ(scenarios[0]["scenario_id"], "sensor_failure");
}

TEST(OpcUaFleet, TelemetryInterruptionAtStartupPublishesNothingGoodYet) {
  FleetConfig fleet = default_fleet();
  fleet.vessels[0].initial_scenarios.push_back({"telemetry_interruption", 0});
  SimulatorOptions options;
  options.fleet = fleet;
  RunningSimulator simulator(std::move(options));
  Client client;
  ASSERT_EQ(client.connect(simulator.endpoint()), UA_STATUSCODE_GOOD);
  EXPECT_EQ(client.read("VES-001.ME1.Temperature").status(),
            UA_STATUSCODE_BADWAITINGFORINITIALDATA);
  EXPECT_EQ(client.read("VES-002.ME1.Temperature").status(), UA_STATUSCODE_GOOD);
}

}  // namespace
}  // namespace seatrace::sim
