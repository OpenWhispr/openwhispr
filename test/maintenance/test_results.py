import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('checks', Path(__file__).resolve().parents[2] / 'scripts' / 'check-maintenance-tests.py')
assert spec is not None and spec.loader is not None
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class ResultsTests(unittest.TestCase):
    def test_new_failure_is_blocked(self):
        self.assertEqual(checks.compare({'a': 'pass'}, {'a': 'fail'})['new_failures'], ['a'])

    def test_new_skip_is_blocked(self):
        self.assertEqual(checks.compare({'a': 'pass'}, {'a': 'skip'})['new_skips'], ['a'])

    def test_deleted_test_is_blocked(self):
        self.assertEqual(checks.compare({'a': 'pass'}, {})['missing'], ['a'])

    def test_existing_failure_is_not_called_a_pass(self):
        r = checks.compare({'a': 'fail'}, {'a': 'fail', 'b': 'pass'})
        self.assertEqual(r['new_failures'], [])
        self.assertEqual(r['candidate_failures'], ['a'])

    def test_xml_suite_names_disambiguate(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'results.xml'
            f.write_text('<testsuites><testsuite name="one"><testcase name="x"/></testsuite><testsuite name="two"><testcase name="x"><failure/></testcase></testsuite></testsuites>')
            self.assertEqual(checks.read_results(f), {'one / x': 'pass', 'two / x': 'fail'})

    def test_same_name_in_different_files_is_distinct(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'results.xml'
            f.write_text('<testsuites><testcase name="same" file="/runner/a/test/one.test.js"/><testcase name="same" file="/runner/a/test/two.test.js"><failure/></testcase></testsuites>')
            self.assertEqual(checks.read_results(f), {'test/one.test.js / same': 'pass', 'test/two.test.js / same': 'fail'})

    def test_repeated_titles_in_one_file_preserve_every_result(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'results.xml'
            f.write_text('<testsuites><testcase name="same" file="test/a.js"/><testcase name="same" file="test/a.js"><failure/></testcase></testsuites>')
            self.assertEqual(checks.read_results(f), {'test/a.js / same': 'pass', 'test/a.js / same [occurrence 2]': 'fail'})

    def test_runtime_quote_encoding_does_not_change_identity(self):
        with tempfile.TemporaryDirectory() as d:
            old, new = Path(d) / 'old.xml', Path(d) / 'new.xml'
            old.write_text('<testsuites><testcase name="a &amp;quot;quote&amp;quot;" file="test/a.js"/></testsuites>')
            new.write_text('<testsuites><testcase name="a &quot;quote&quot;" file="test/a.js"/></testsuites>')
            self.assertEqual(checks.read_results(old, double_escaped=True), checks.read_results(new))

    def test_literal_entity_in_new_runtime_is_not_unescaped(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'results.xml'
            f.write_text('<testsuites><testcase name="literal &amp;quot;"/></testsuites>')
            self.assertEqual(checks.read_results(f), {'literal &quot;': 'pass'})

    def test_reviewed_upstream_rename_retains_identity(self):
        old = 'test/helpers/hyprlandShortcut.test.js / replaces an old dofile loader before a trailing top-level return'
        new = 'test/helpers/hyprlandShortcut.test.js / keeps an existing dofile loader before a trailing top-level return'
        self.assertEqual(checks.compare({old: 'pass'}, {new: 'pass'})['missing'], [])
        self.assertEqual(checks.compare({old: 'pass'}, {new: 'fail'})['new_failures'], [new])
        self.assertEqual(checks.compare({old: 'pass'}, {})['missing'], [old])

    def test_new_platform_skip_requires_an_actual_pass(self):
        self.assertEqual(checks.compare({}, {'mac': 'skip'}, {'mac': 'pass'})['new_skips'], [])
        self.assertEqual(checks.compare({}, {'mac': 'skip'}, {'mac': 'skip'})['new_skips'], ['mac'])
        self.assertEqual(checks.compare({'mac': 'pass'}, {'mac': 'skip'}, {'mac': 'pass'})['new_skips'], ['mac'])
        self.assertEqual(checks.compare({}, {'mac': 'skip'}, {'mac': 'fail'})['new_failures'], ['mac'])

    def test_platform_files_reject_paths_outside_tests(self):
        with self.assertRaises(ValueError):
            checks.platform_files({}, {'../../evil.js / name': 'skip'})
        self.assertEqual(checks.platform_files({}, {'test/helpers/mac.test.js / name': 'skip'}), ['test/helpers/mac.test.js'])
        self.assertEqual(checks.platform_files({'test/a.test.js / old': 'pass'}, {'test/a.test.js / old': 'skip'}), [])

    def test_empty_output_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'results.xml'
            f.write_text('<testsuites/>')
            with self.assertRaises(ValueError):
                checks.read_results(f)

if __name__ == '__main__':
    unittest.main()
