#!/usr/bin/env python3
"""Run real suites and reject new failures, skipped or missing tests."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET


def read_results(path, double_escaped=False):
    root = ET.parse(path).getroot()
    results = {}
    def title(node):
        name = node.attrib.get('name', '')
        return name.replace('&quot;', '"') if double_escaped else name
    def walk(node, parents):
        current = parents + ([title(node)] if node.tag == 'testsuite' else [])
        for item in node:
            if item.tag == 'testcase':
                filename = item.attrib.get('file', '')
                # Node JUnit supplies absolute file paths, which differ by runner.
                # Normalize at the repository's test/ directory, retaining the
                # filename so equal test titles in different files stay distinct.
                if '/test/' in filename:
                    filename = 'test/' + filename.split('/test/', 1)[1]
                key = ' / '.join(([filename] if filename else []) + current + [title(item)])
                original_key = key
                occurrence = 1
                while key in results:
                    occurrence += 1
                    key = original_key + ' [occurrence ' + str(occurrence) + ']'
                results[key] = 'fail' if item.find('failure') is not None or item.find('error') is not None else 'skip' if item.find('skipped') is not None else 'pass'
            else:
                walk(item, current)
    walk(root, [])
    if not results:
        raise ValueError('Test runner produced no test results')
    return results


# Reviewed upstream bug corrections that changed the test's descriptive title.
# These are exact, controller-owned identities, not candidate-supplied exceptions.
# 9ce28e8f: preserve the existing dofile loader instead of replacing user config.
# 16bd3497: persist the transcript on insertion, with diarization metadata separate.
REVIEWED_RENAMES = {
    'test/helpers/hyprlandShortcut.test.js / replaces an old dofile loader before a trailing top-level return':
        'test/helpers/hyprlandShortcut.test.js / keeps an existing dofile loader before a trailing top-level return',
    'test/services/uploadNotes.test.js / segments and diarization metadata share one noteUpdates write':
        'test/services/uploadNotes.test.js / diarization metadata follows the insert separately from the transcript',
}


def compare(baseline, candidate, platform_results=None):
    baseline = dict(baseline)
    renamed = {}
    for old, new in REVIEWED_RENAMES.items():
        if old in baseline and old not in candidate and new in candidate:
            if new in baseline:
                raise ValueError('Ambiguous reviewed test rename: ' + old)
            baseline[new] = baseline.pop(old)
            renamed[old] = new
    platform_results = platform_results or {}
    # Supplemental native-platform runs can cover only NEW platform-only tests.
    # Never use a pass elsewhere to conceal an existing Linux pass becoming a skip.
    def native_passed(key):
        if key in platform_results:
            return platform_results[key] == 'pass'
        # JUnit reports a skipped nested test as one testcase, but an executed
        # parent as a testsuite containing its actual subtests.
        children = [v for k, v in platform_results.items() if k.startswith(key + ' / ')]
        return bool(children) and all(v == 'pass' for v in children)
    covered = [k for k, v in candidate.items()
               if v == 'skip' and k not in baseline and native_passed(k)]
    return {
        'missing': sorted(set(baseline) - set(candidate)),
        'new_failures': sorted({k for k, v in candidate.items() if v == 'fail' and baseline.get(k) != 'fail'}
                               | {k for k, v in platform_results.items() if v == 'fail'}),
        'new_skips': sorted(k for k, v in candidate.items() if v == 'skip' and baseline.get(k) != 'skip' and k not in covered),
        'baseline_failures': sorted(k for k, v in baseline.items() if v == 'fail'),
        'candidate_failures': sorted(k for k, v in candidate.items() if v == 'fail'),
        'reviewed_renames': renamed,
        'passed_on_native_platform': sorted(covered),
    }


def platform_files(baseline, candidate):
    files = sorted({k.split(' / ', 1)[0] for k, v in candidate.items()
                    if v == 'skip' and k not in baseline})
    for name in files:
        if not name.startswith('test/') or not name.endswith('.test.js') or '..' in Path(name).parts:
            raise ValueError('Invalid platform test path: ' + name)
    return files


def run(repo, output, focused, files_from=None):
    repo = Path(repo).resolve()
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    policy = json.loads((repo / '.github/personal-fork-policy.json').read_text())
    files = policy['protected_tests'] if focused else sorted(str(p.relative_to(repo)) for p in (repo / 'test').rglob('*.test.js'))
    if files_from:
        files = json.loads(Path(files_from).read_text())
        if not isinstance(files, list) or any(not isinstance(n, str) for n in files):
            raise ValueError('Platform file list must contain strings')
        platform_files({}, {n + ' / test': 'skip' for n in files})
        if not files:
            (output / 'results.json').write_text('{}\n')
            print(json.dumps({'files': 0, 'reason': 'No new platform-only tests'}))
            return
    for name in files:
        if not (repo / name).is_file() or not (repo / name).resolve().is_relative_to(repo):
            raise ValueError('Required test missing: ' + name)
    xml = output / 'results.xml'
    env = dict(os.environ, ELECTRON_RUN_AS_NODE='1', REQUIRE_DB_TESTS='1')
    # No provider, GitHub or Claude credentials are needed by application tests.
    for key in list(env):
        if any(x in key.upper() for x in ('TOKEN', 'API_KEY', 'SECRET', 'PASSWORD')):
            env.pop(key)
    executable = 'Electron.app/Contents/MacOS/Electron' if sys.platform == 'darwin' else 'electron'
    binary = str(repo / 'node_modules/electron/dist' / executable)
    # Probe this actual runtime: older Node JUnit reporters double-escape titles.
    # Never blindly HTML-decode modern output (literal entity names are distinct).
    probe_name = 'reporter probe: \" &quot; < & >'
    probe = output / 'reporter-probe.cjs'
    probe_xml = output / 'reporter-probe.xml'
    probe.write_text('require("node:test")(' + json.dumps(probe_name) + ', () => {});\n')
    subprocess.run([binary, '--test', '--test-reporter=junit',
                    '--test-reporter-destination=' + str(probe_xml), str(probe)],
                   cwd=repo, env=env, check=True, timeout=30, capture_output=True)
    names = [n.attrib['name'] for n in ET.parse(probe_xml).getroot().iter('testcase')]
    if names == [probe_name]:
        double_escaped = False
    elif names == [probe_name.replace('"', '&quot;')]:
        double_escaped = True
    else:
        raise ValueError('Unsupported test reporter title encoding: ' + repr(names))
    (output / 'reporter.json').write_text(json.dumps({'double_escaped': double_escaped}))
    cmd = [binary, '--import', 'tsx', '--test', '--test-concurrency=4', '--test-reporter=junit', '--test-reporter-destination=' + str(xml), *files]
    with (output / 'runner.log').open('w') as log:
        proc = subprocess.run(cmd, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
    if proc.returncode not in (0, 1):
        raise ValueError('Test runner crashed: ' + str(proc.returncode))
    if files_from and proc.returncode != 0:
        raise ValueError('Native test runner failed: ' + str(proc.returncode))
    result = read_results(xml, double_escaped=double_escaped)
    (output / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    counts = {s: list(result.values()).count(s) for s in ('pass', 'fail', 'skip')}
    print(json.dumps({'files': len(files), **counts}))
    if proc.returncode == 1 and counts['fail'] == 0:
        raise ValueError('Runner failed without an attributable test failure')
    if focused and (counts['fail'] or counts['skip']):
        raise ValueError('Protected fork tests must all pass without skips')


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='command', required=True)
    r = sub.add_parser('run')
    r.add_argument('--repo', required=True)
    r.add_argument('--output', required=True)
    r.add_argument('--focused', action='store_true')
    r.add_argument('--files-from')
    s = sub.add_parser('platform-files')
    s.add_argument('baseline')
    s.add_argument('candidate')
    c = sub.add_parser('compare')
    c.add_argument('baseline')
    c.add_argument('candidate')
    c.add_argument('--platform-results')
    a = p.parse_args()
    if a.command == 'run':
        run(a.repo, a.output, a.focused, a.files_from)
    elif a.command == 'platform-files':
        print(json.dumps(platform_files(json.loads(Path(a.baseline).read_text()), json.loads(Path(a.candidate).read_text()))))
    else:
        native = json.loads(Path(a.platform_results).read_text()) if a.platform_results else None
        report = compare(json.loads(Path(a.baseline).read_text()), json.loads(Path(a.candidate).read_text()), native)
        print(json.dumps(report, indent=2))
        if any(report[k] for k in ('missing', 'new_failures', 'new_skips')):
            raise ValueError('Candidate introduced test regressions or missing checks')

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
