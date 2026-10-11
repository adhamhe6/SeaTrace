// seatrace_simulator: vessel simulator with an OPC UA server (see docs/opc-ua-model.md).
//
// Exit codes: 0 clean shutdown, 2 invalid command line / environment / fleet configuration,
// 3 the OPC UA server could not be set up or started (certificates, port in use, ...).

#include <csignal>
#include <cstdlib>
#include <iostream>

#include "core/config.hpp"
#include "core/logger.hpp"
#include "core/settings.hpp"
#include "core/simulation.hpp"
#include "opcua/runner.hpp"
#include "opcua/server.hpp"

namespace {

constexpr int kExitConfigError = 2;
constexpr int kExitRuntimeError = 3;

std::atomic<bool> g_stop_requested{false};
static_assert(std::atomic<bool>::is_always_lock_free, "needed for use in a signal handler");

extern "C" void request_stop(int /*signal*/) { g_stop_requested.store(true); }

void install_signal_handlers() {
  struct sigaction action {};
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, nullptr);
  sigaction(SIGTERM, &action, nullptr);
  std::signal(SIGPIPE, SIG_IGN);
}

std::optional<std::string> environment(std::string_view name) {
  const char* value = std::getenv(std::string(name).c_str());
  if (value == nullptr) return std::nullopt;
  return std::string(value);
}

}  // namespace

int main(int argc, char** argv) {
  using namespace seatrace::sim;

  Settings settings;
  try {
    settings = parse_settings(std::vector<std::string>(argv + 1, argv + argc), environment);
  } catch (const SettingsError& error) {
    std::cerr << "seatrace_simulator: invalid configuration: " << error.what() << "\n";
    return kExitConfigError;
  }
  if (settings.show_help) {
    std::cout << usage_text();
    return 0;
  }

  Logger logger(std::cout, settings.log_level);
  try {
    const FleetConfig fleet = load_fleet_config(settings.config_path);
    logger.info("starting SeaTrace simulator", loggable(settings));

    Simulation simulation(fleet, settings.seed, wall_clock_now());
    opcua::OpcUaServer server(simulation, logger, opcua::make_server_options(settings));
    server.start();

    install_signal_handlers();
    opcua::Runner runner(simulation, server, logger, std::chrono::milliseconds(settings.tick_ms));
    runner.run(g_stop_requested);
    logger.info("shutdown complete");
    return 0;
  } catch (const ConfigError& error) {
    logger.error("invalid fleet configuration", {{"error", std::string(error.what())}});
    std::cerr << "seatrace_simulator: invalid configuration: " << error.what() << "\n";
    return kExitConfigError;
  } catch (const opcua::ServerError& error) {
    logger.error("OPC UA server failure", {{"error", std::string(error.what())}});
    std::cerr << "seatrace_simulator: OPC UA server failure: " << error.what() << "\n";
    return kExitRuntimeError;
  } catch (const std::exception& error) {
    logger.error("fatal error", {{"error", std::string(error.what())}});
    std::cerr << "seatrace_simulator: fatal error: " << error.what() << "\n";
    return kExitRuntimeError;
  }
}
