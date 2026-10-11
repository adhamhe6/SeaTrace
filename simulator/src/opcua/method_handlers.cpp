#include "opcua/method_handlers.hpp"

#include <array>
#include <optional>

#include "opcua/access_control.hpp"
#include "opcua/ua_util.hpp"

namespace seatrace::sim::opcua {

namespace {

std::optional<std::string> string_argument(const UA_Variant& variant) {
  if (!UA_Variant_hasScalarType(&variant, &UA_TYPES[UA_TYPES_STRING])) return std::nullopt;
  return to_std_string(*static_cast<const UA_String*>(variant.data));
}

std::optional<std::uint32_t> uint32_argument(const UA_Variant& variant) {
  if (!UA_Variant_hasScalarType(&variant, &UA_TYPES[UA_TYPES_UINT32])) return std::nullopt;
  return *static_cast<const UA_UInt32*>(variant.data);
}

UA_StatusCode write_outputs(const ScenarioResult& result, size_t output_size, UA_Variant* output) {
  if (output_size != 2) return UA_STATUSCODE_BADINTERNALERROR;
  const UA_Boolean accepted = result.accepted;
  UA_StatusCode status =
      UA_Variant_setScalarCopy(&output[0], &accepted, &UA_TYPES[UA_TYPES_BOOLEAN]);
  if (status != UA_STATUSCODE_GOOD) return status;
  const UA_String message = ua_view(result.message);
  return UA_Variant_setScalarCopy(&output[1], &message, &UA_TYPES[UA_TYPES_STRING]);
}

// Shared prologue/epilogue of the three methods.
UA_StatusCode dispatch(void* method_context, void* session_context, std::string_view method,
                       size_t input_size, size_t expected_inputs, size_t output_size,
                       UA_Variant* output,
                       const std::function<ScenarioResult(ControlContext&)>& action) {
  auto& context = *static_cast<ControlContext*>(method_context);
  if (!is_control_session(session_context)) {
    context.logger.warn("method call denied: control account required",
                        {{"method", std::string(method)}});
    return UA_STATUSCODE_BADUSERACCESSDENIED;
  }
  if (input_size < expected_inputs) return UA_STATUSCODE_BADARGUMENTSMISSING;
  if (input_size > expected_inputs) return UA_STATUSCODE_BADTOOMANYARGUMENTS;

  const ScenarioResult result = action(context);
  context.logger.info("control method called", {{"method", std::string(method)},
                                                {"accepted", result.accepted},
                                                {"message", result.message}});
  context.scenarios_changed();
  return write_outputs(result, output_size, output);
}

UA_StatusCode activate_scenario(UA_Server*, const UA_NodeId*, void* session_context,
                                const UA_NodeId*, void* method_context, const UA_NodeId*, void*,
                                size_t input_size, const UA_Variant* input, size_t output_size,
                                UA_Variant* output) {
  return dispatch(method_context, session_context, "ActivateScenario", input_size, 3, output_size,
                  output, [&](ControlContext& context) -> ScenarioResult {
                    const auto vessel = string_argument(input[0]);
                    const auto scenario = string_argument(input[1]);
                    const auto duration = uint32_argument(input[2]);
                    if (!vessel || !scenario || !duration) {
                      return {false, "invalid argument types (expected String, String, UInt32)"};
                    }
                    context.logger.info(
                        "activating scenario",
                        {{"vessel", *vessel}, {"scenario", *scenario}, {"duration_s", *duration}});
                    return context.simulation.scenarios().activate(*vessel, *scenario, *duration,
                                                                   context.simulation.now());
                  });
}

UA_StatusCode clear_scenario(UA_Server*, const UA_NodeId*, void* session_context, const UA_NodeId*,
                             void* method_context, const UA_NodeId*, void*, size_t input_size,
                             const UA_Variant* input, size_t output_size, UA_Variant* output) {
  return dispatch(method_context, session_context, "ClearScenario", input_size, 2, output_size,
                  output, [&](ControlContext& context) -> ScenarioResult {
                    const auto vessel = string_argument(input[0]);
                    const auto scenario = string_argument(input[1]);
                    if (!vessel || !scenario) {
                      return {false, "invalid argument types (expected String, String)"};
                    }
                    return context.simulation.scenarios().clear(*vessel, *scenario);
                  });
}

UA_StatusCode reset_scenarios(UA_Server*, const UA_NodeId*, void* session_context, const UA_NodeId*,
                              void* method_context, const UA_NodeId*, void*, size_t input_size,
                              const UA_Variant*, size_t output_size, UA_Variant* output) {
  return dispatch(method_context, session_context, "ResetScenarios", input_size, 0, output_size,
                  output,
                  [](ControlContext& context) { return context.simulation.scenarios().reset(); });
}

UA_Argument make_argument(const char* name, const char* description, UA_UInt32 type_index) {
  UA_Argument argument;
  UA_Argument_init(&argument);
  argument.name = ua_view(name);
  argument.description = ua_text(description);
  argument.dataType = UA_TYPES[type_index].typeId;
  argument.valueRank = UA_VALUERANK_SCALAR;
  return argument;
}

UA_StatusCode add_method(UA_Server* server, UA_UInt16 ns, const UA_NodeId& parent, const char* name,
                         const char* description, UA_MethodCallback callback,
                         std::initializer_list<UA_Argument> inputs, ControlContext& context) {
  const std::string node_id = std::string("Simulator.") + name;
  const std::array<UA_Argument, 2> outputs{
      make_argument("accepted", "True when the request was applied", UA_TYPES_BOOLEAN),
      make_argument("message", "Human readable outcome", UA_TYPES_STRING)};

  UA_MethodAttributes attributes = UA_MethodAttributes_default;
  attributes.displayName = ua_text(name);
  attributes.description = ua_text(description);
  attributes.executable = true;
  attributes.userExecutable = true;

  std::array<UA_Argument, 3> input_array{};
  size_t count = 0;
  for (const UA_Argument& argument : inputs) input_array[count++] = argument;

  return UA_Server_addMethodNode(
      server, ua_node_id(ns, node_id), parent, UA_NODEID_NUMERIC(0, UA_NS0ID_HASCOMPONENT),
      ua_qualified_name(ns, name), attributes, callback, count,
      count == 0 ? nullptr : input_array.data(), outputs.size(), outputs.data(), &context, nullptr);
}

}  // namespace

UA_StatusCode add_control_methods(UA_Server* server, UA_UInt16 ns, const UA_NodeId& parent,
                                  ControlContext& context) {
  UA_StatusCode status = add_method(
      server, ns, parent, "ActivateScenario",
      "Activates a fault scenario on a vessel (control account only)", activate_scenario,
      {make_argument("vesselId", "Vessel code, e.g. VES-001", UA_TYPES_STRING),
       make_argument("scenarioId", "Scenario identifier, e.g. engine_overheat", UA_TYPES_STRING),
       make_argument("durationSeconds",
                     "Duration in seconds; 0 = until cleared (or the scenario default)",
                     UA_TYPES_UINT32)},
      context);
  if (status != UA_STATUSCODE_GOOD) return status;
  status = add_method(
      server, ns, parent, "ClearScenario",
      "Clears one scenario, or all scenarios of a vessel (control account only)", clear_scenario,
      {make_argument("vesselId", "Vessel code", UA_TYPES_STRING),
       make_argument("scenarioId", "Scenario identifier; empty = all scenarios of the vessel",
                     UA_TYPES_STRING)},
      context);
  if (status != UA_STATUSCODE_GOOD) return status;
  return add_method(server, ns, parent, "ResetScenarios", "Clears every active scenario",
                    reset_scenarios, {}, context);
}

}  // namespace seatrace::sim::opcua
