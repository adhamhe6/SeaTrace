#include "core/rng.hpp"

#include <cmath>

#include "core/math_util.hpp"

namespace seatrace::sim {

std::uint64_t splitmix64(std::uint64_t x) {
  x += 0x9E3779B97F4A7C15ULL;
  x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
  x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
  return x ^ (x >> 31);
}

std::uint64_t fnv1a64(std::string_view text) {
  std::uint64_t hash = 0xCBF29CE484222325ULL;
  for (const char c : text) {
    hash ^= static_cast<std::uint8_t>(c);
    hash *= 0x100000001B3ULL;
  }
  return hash;
}

std::uint64_t derive_seed(std::uint64_t global_seed, std::string_view label) {
  return splitmix64(global_seed ^ splitmix64(fnv1a64(label)));
}

Rng::Rng(std::uint64_t seed) : engine_(seed) {}

double Rng::uniform() {
  return static_cast<double>(engine_() >> 11) * (1.0 / 9007199254740992.0);  // 2^-53
}

double Rng::gaussian() {
  if (has_spare_) {
    has_spare_ = false;
    return spare_;
  }
  // u1 in (0, 1] so that log(u1) is finite.
  const double u1 = 1.0 - uniform();
  const double u2 = uniform();
  const double radius = std::sqrt(-2.0 * std::log(u1));
  const double angle = kTwoPi * u2;
  spare_ = radius * std::sin(angle);
  has_spare_ = true;
  return radius * std::cos(angle);
}

}  // namespace seatrace::sim
