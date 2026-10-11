#include "core/logger.hpp"

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>
#include <sstream>

namespace seatrace::sim {
namespace {

TEST(Logger, WritesOneJsonObjectPerLineWithMandatoryFields) {
  std::ostringstream out;
  Logger logger(out, LogLevel::kInfo);
  logger.info("hello", {{"port", 4840}, {"mode", "none"}});
  logger.warn("careful");

  std::istringstream lines(out.str());
  std::string line;
  ASSERT_TRUE(std::getline(lines, line));
  const auto first = nlohmann::json::parse(line);
  EXPECT_EQ(first["level"], "info");
  EXPECT_EQ(first["msg"], "hello");
  EXPECT_EQ(first["port"], 4840);
  EXPECT_EQ(first["mode"], "none");
  EXPECT_TRUE(first["ts"].get<std::string>().ends_with("Z"));
  ASSERT_TRUE(std::getline(lines, line));
  EXPECT_EQ(nlohmann::json::parse(line)["level"], "warn");
  EXPECT_FALSE(std::getline(lines, line));
}

TEST(Logger, FiltersBelowTheMinimumLevel) {
  std::ostringstream out;
  Logger logger(out, LogLevel::kWarn);
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  EXPECT_EQ(out.str().find("\"d\""), std::string::npos);
  EXPECT_EQ(out.str().find("\"i\""), std::string::npos);
  EXPECT_NE(out.str().find("\"w\""), std::string::npos);
  EXPECT_NE(out.str().find("\"e\""), std::string::npos);
}

TEST(Logger, SurvivesInvalidUtf8) {
  std::ostringstream out;
  Logger logger(out, LogLevel::kInfo);
  EXPECT_NO_THROW(logger.info(std::string("bad \xff\xfe bytes")));
  EXPECT_NE(out.str().find("bad"), std::string::npos);
}

TEST(Logger, ParsesLevels) {
  EXPECT_EQ(parse_log_level("debug"), LogLevel::kDebug);
  EXPECT_EQ(parse_log_level("warning"), LogLevel::kWarn);
  EXPECT_FALSE(parse_log_level("loud").has_value());
}

}  // namespace
}  // namespace seatrace::sim
