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

    def test_empty_output_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'results.xml'
            f.write_text('<testsuites/>')
            with self.assertRaises(ValueError):
                checks.read_results(f)

if __name__ == '__main__':
    unittest.main()
