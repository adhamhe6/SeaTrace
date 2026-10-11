#pragma once

#include <chrono>
#include <string>

namespace seatrace::sim {

// Simulation time: UTC wall-clock time with millisecond resolution. It advances by exactly one
// tick per Simulation::step, so it is reproducible for a given start time.
using SimTime = std::chrono::sys_time<std::chrono::milliseconds>;

SimTime wall_clock_now();

// "2026-01-01T12:00:00.000Z"
std::string format_iso8601(SimTime t);

}  // namespace seatrace::sim
