#include "opcua/runner.hpp"

#include <algorithm>
#include <thread>

namespace seatrace::sim::opcua {

namespace {
using Clock = std::chrono::steady_clock;
constexpr int kMaxCatchUpTicks = 10;
constexpr std::chrono::milliseconds kMaxWait{20};
constexpr std::chrono::seconds kRestartRetry{1};
}  // namespace

Runner::Runner(Simulation& simulation, OpcUaServer& server, Logger& logger,
               std::chrono::milliseconds tick)
    : simulation_(simulation), server_(server), logger_(logger), tick_(tick) {}

void Runner::tick() {
  simulation_.step(tick_);
  for (const StateChange& change : simulation_.take_state_changes()) {
    logger_.info("equipment state changed", {{"vessel", change.vessel_id},
                                             {"equipment", change.equipment_code},
                                             {"from", std::string(to_string(change.from))},
                                             {"to", std::string(to_string(change.to))},
                                             {"sim_time", format_iso8601(change.at)}});
  }
  for (const ActiveScenario& expired : simulation_.take_expired_scenarios()) {
    logger_.info("scenario expired", {{"scenario", std::string(definition(expired.id).name)},
                                      {"vessel", expired.vessel_id}});
  }
  server_.publish();
}

void Runner::reconcile_listener() {
  const bool want_down = simulation_.scenarios().listener_down(simulation_.now());
  if (want_down && server_.listening()) {
    logger_.warn("opcua_outage: stopping the OPC UA listener; the simulation keeps running");
    server_.stop();
  } else if (!want_down && !server_.listening() && Clock::now() >= next_restart_attempt_) {
    try {
      server_.start();
      logger_.info("opcua_outage over: OPC UA listener restarted");
    } catch (const ServerError& error) {
      logger_.error("cannot restart the OPC UA listener, retrying",
                    {{"error", std::string(error.what())}});
      next_restart_attempt_ = Clock::now() + kRestartRetry;
    }
  }
}

void Runner::run(const std::atomic<bool>& stop) {
  auto next_tick = Clock::now() + tick_;
  while (!stop.load(std::memory_order_relaxed)) {
    int caught_up = 0;
    while (Clock::now() >= next_tick) {
      if (caught_up == kMaxCatchUpTicks) {
        logger_.warn("simulation cannot keep up with the tick rate; skipping ticks");
        next_tick = Clock::now() + tick_;
        break;
      }
      tick();
      next_tick += tick_;
      ++caught_up;
    }
    reconcile_listener();

    const auto until_tick = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::max(next_tick - Clock::now(), Clock::duration::zero()));
    const auto wait = std::min(until_tick, kMaxWait);
    if (server_.listening()) {
      server_.iterate(wait);
    } else {
      std::this_thread::sleep_for(wait);
    }
  }
  server_.stop();
}

}  // namespace seatrace::sim::opcua
