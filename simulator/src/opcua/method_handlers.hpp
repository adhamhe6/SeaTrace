#pragma once

#include <open62541/server.h>

#include <functional>
#include <string>

#include "core/logger.hpp"
#include "core/simulation.hpp"

namespace seatrace::sim::opcua {

// Everything the control methods need. Method callbacks run on the server thread, which is also
// the simulation thread, so the handlers use the simulation directly.
struct ControlContext {
  Simulation& simulation;
  Logger& logger;
  // Invoked after every successful method call so that ActiveScenarios is refreshed at once.
  std::function<void()> scenarios_changed;
};

// Adds ActivateScenario, ClearScenario and ResetScenarios below `parent`. The NodeIds are
// "Simulator.ActivateScenario" etc. in namespace `ns`. `context` must outlive the server.
UA_StatusCode add_control_methods(UA_Server* server, UA_UInt16 ns, const UA_NodeId& parent,
                                  ControlContext& context);

}  // namespace seatrace::sim::opcua
