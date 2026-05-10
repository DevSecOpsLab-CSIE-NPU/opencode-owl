"""Tests for evals/scorers/*.py"""
import pytest

from evals.scorers.log_classifier import classify
from evals.scorers.unit_test import score as unit_score
from evals.scorers.diff_quality import score as diff_score


# ---------------------------------------------------------------------------
# log_classifier
# ---------------------------------------------------------------------------

class TestLogClassifier:
    def test_exit_zero_is_pass(self):
        assert classify("3 passed", "", 0) == "pass"

    def test_exit_zero_is_pass_even_with_warnings(self):
        assert classify("warning: something\n3 passed", "", 0) == "pass"

    def test_timeout_keyword(self):
        assert classify("", "Timed out after 30s", 1) == "timeout"

    def test_timeout_sigkill(self):
        assert classify("", "Process received SIGKILL", 1) == "timeout"

    def test_timeout_case_insensitive(self):
        assert classify("", "TIMEOUT", 1) == "timeout"

    def test_parse_error_syntax(self):
        assert classify("SyntaxError: Unexpected token", "", 1) == "parse_error"

    def test_parse_error_json(self):
        assert classify("", "JSON.parse error at line 1", 1) == "parse_error"

    def test_tool_error_enoent(self):
        assert classify("", "ENOENT: No such file or directory", 1) == "tool_error"

    def test_tool_error_command_not_found(self):
        assert classify("", "bash: opencode: command not found", 1) == "tool_error"

    def test_tool_error_permission(self):
        assert classify("", "Permission denied", 1) == "tool_error"

    def test_test_fail_assertion(self):
        assert classify("AssertionError: expected 1 to be 2", "", 1) == "test_fail"

    def test_test_fail_pattern(self):
        assert classify("✗ clamp test", "", 1) == "test_fail"

    def test_test_fail_FAIL_keyword(self):
        assert classify("FAIL src/utils.test.ts", "", 1) == "test_fail"

    def test_edit_fail(self):
        assert classify("", "edit failed: string not found", 1) == "edit_fail"

    def test_edit_fail_not_unique(self):
        assert classify("", "old_string not unique in file", 1) == "edit_fail"

    def test_unknown_fail(self):
        assert classify("something went wrong", "no match here", 1) == "unknown_fail"

    def test_timeout_takes_priority_over_test_fail(self):
        # If both patterns appear, timeout matches first (earlier in _RULES)
        result = classify("Timed out\nAssertionError", "", 1)
        assert result == "timeout"

    # Claude Code JSON output handling
    def test_claude_code_json_success_is_pass(self):
        import json
        stdout = json.dumps({"type": "result", "subtype": "success", "is_error": False,
                             "result": "4", "permission_denials": []})
        assert classify(stdout, "", 0) == "pass"

    def test_claude_code_json_is_error_true_nonzero(self):
        import json
        stdout = json.dumps({"type": "result", "is_error": True, "result": ""})
        assert classify(stdout, "", 1) == "tool_error"

    def test_claude_code_json_permission_denial_exit0(self):
        import json
        stdout = json.dumps({"type": "result", "is_error": False,
                             "permission_denials": [{"tool": "Bash", "reason": "not allowed"}],
                             "result": ""})
        assert classify(stdout, "", 0) == "tool_error"

    def test_claude_code_empty_permission_denials_is_pass(self):
        import json
        stdout = json.dumps({"type": "result", "is_error": False, "permission_denials": [], "result": "done"})
        assert classify(stdout, "", 0) == "pass"


# ---------------------------------------------------------------------------
# unit_test scorer
# ---------------------------------------------------------------------------

class TestUnitTestScorer:
    def test_all_pass(self):
        result = unit_score("3 passed", "", 0)
        assert result["outcome"] == "pass"
        assert result["pass_at_1"] == 1.0
        assert result["tests_passed"] == 3
        assert result["tests_failed"] == 0
        assert result["test_fail_rate"] == 0.0

    def test_all_fail(self):
        result = unit_score("0 passed\n2 failed", "", 1)
        assert result["outcome"] == "fail"
        assert result["pass_at_1"] == 0.0
        assert result["tests_failed"] == 2

    def test_mixed(self):
        result = unit_score("3 passed\n1 failed", "", 1)
        assert result["outcome"] == "fail"
        assert result["tests_passed"] == 3
        assert result["tests_failed"] == 1
        assert result["test_fail_rate"] == pytest.approx(0.25)

    def test_exit_zero_no_counts(self):
        result = unit_score("ok", "", 0)
        assert result["outcome"] == "pass"
        assert result["test_fail_rate"] == 0.0

    def test_exit_nonzero_no_counts(self):
        result = unit_score("", "", 1)
        assert result["outcome"] == "fail"
        assert result["test_fail_rate"] == 1.0

    def test_exit_zero_with_failures_is_fail(self):
        # test output shows failures but exit code is 0 (unusual but tested)
        result = unit_score("2 passed\n1 failed", "", 0)
        assert result["outcome"] == "fail"


# ---------------------------------------------------------------------------
# diff_quality scorer
# ---------------------------------------------------------------------------

class TestDiffQualityScorer:
    CLEAN_DIFF = """\
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,6 @@
+export function clamp(n: number, min: number, max: number): number {
+  return Math.min(Math.max(n, min), max);
+}
"""

    def test_empty_diff(self):
        result = diff_score("")
        assert result["lines_added"] == 0
        assert result["lines_removed"] == 0
        assert result["files_changed"] == 0

    def test_counts_added_lines(self):
        result = diff_score(self.CLEAN_DIFF)
        assert result["lines_added"] == 3

    def test_counts_files_changed(self):
        result = diff_score(self.CLEAN_DIFF)
        assert result["files_changed"] == 1

    def test_no_noise_in_clean_diff(self):
        result = diff_score(self.CLEAN_DIFF)
        assert result["noise_ratio"] == 0.0

    def test_noise_ratio_whitespace_lines(self):
        noisy_diff = """\
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,2 +1,3 @@
+
+export function foo() {}
-
"""
        result = diff_score(noisy_diff)
        # 3 changed lines: 2 blank (+/- blank), 1 code
        assert result["noise_ratio"] > 0

    def test_precision_all_expected(self):
        result = diff_score(self.CLEAN_DIFF, expected_files=["src/utils.ts"])
        assert result["precision"] == 1.0

    def test_precision_unexpected_file(self):
        result = diff_score(self.CLEAN_DIFF, expected_files=["src/other.ts"])
        assert result["precision"] == 0.0

    def test_precision_partial_match(self):
        two_file_diff = """\
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
+// a
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,2 @@
+// b
"""
        result = diff_score(two_file_diff, expected_files=["src/a.ts"])
        assert 0 < result["precision"] < 1.0
