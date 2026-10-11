#pragma once

#include <algorithm>
#include <cmath>

namespace seatrace::sim {

inline constexpr double kTwoPi = 6.283185307179586476925286766559;

inline double clamp01(double v) { return std::clamp(v, 0.0, 1.0); }

// Exact solution of a first-order lag (time constant tau_s) over a step of dt_s seconds.
inline double first_order(double current, double target, double dt_s, double tau_s) {
  if (tau_s <= 0.0) return target;
  return current + (target - current) * (1.0 - std::exp(-dt_s / tau_s));
}

// Moves a 0..1 "scenario level" towards 1 (rising) or 0 (falling). A full swing takes `up_s`
// resp. `down_s` seconds, which gives scenarios a ramp-in and a physical recovery curve.
inline double ramp_level(double level, bool rising, double dt_s, double up_s, double down_s) {
  const double step = rising ? dt_s / up_s : -dt_s / down_s;
  return clamp01(level + step);
}

}  // namespace seatrace::sim
