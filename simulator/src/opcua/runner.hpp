#pragma once

#include <atomic>
#include <chrono>

#include "core/logger.hpp"
#include "core/simulation.hpp"
#include "opcua/server.hpp"

namespace seatrace::sim::opcua {

// The single simulator loop: fixed-rate simulation ticks interleaved with OPC UA network
// processing, all on the calling thread. Also performs the opcua_outage scenario by stopping and
// restarting the server's listener while the simulation keeps stepping.
class Runner {
 public:
  Runner(Simulation& simulation, OpcUaServer& server, Logger& logger,
         std::chrono::milliseconds tick);

  // Runs until `stop` becomes true. The server must already be listening. Returns normally on
  // stop; the listener is shut down before returning.
  void run(const std::atomic<bool>& stop);

 private:
  void tick();
  void reconcile_listener();

  Simulation& simulation_;
  OpcUaServer& server_;
  Logger& logger_;
  std::chrono::milliseconds tick_;
  std::chrono::steady_clock::time_point next_restart_attempt_;
};

}  // namespace seatrace::sim::opcua
