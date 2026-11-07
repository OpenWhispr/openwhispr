#!/usr/bin/env python3
"""Run real suites and reject new failures, skipped or missing tests."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET


def read_results(path):
    root = ET.parse(path).getroot()
    results = {}
    def walk(node, parents):
        current = parents + ([node.attrib.get('name', '')] if node.tag == 'testsuite' else [])
        for item in node:
            if item.tag == 'testcase':
                filename = item.attrib.get('file', '')
                # Node JUnit supplies absolute file paths, which differ by runner.
                # Normalize at the repository's test/ directory, retaining the
                # filename so equal test titles in different files stay distinct.
                if '/test/' in filename:
                    filename = 'test/' + filename.split('/test/', 1)[1]
                key = ' / '.join(([filename] if filename else []) + current + [item.attrib.get('name', '')])
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


def compare(baseline, candidate):
    return {
        'missing': sorted(set(baseline) - set(candidate)),
        'new_failures': sorted(k for k, v in candidate.items() if v == 'fail' and baseline.get(k) != 'fail'),
        'new_skips': sorted(k for k, v in candidate.items() if v == 'skip' and baseline.get(k) != 'skip'),
        'baseline_failures': sorted(k for k, v in baseline.items() if v == 'fail'),
        'candidate_failures': sorted(k for k, v in candidate.items() if v == 'fail'),
    }


def run(repo, output, focused):
    repo = Path(repo).resolve()
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    policy = json.loads((repo / '.github/personal-fork-policy.json').read_text())
    files = policy['protected_tests'] if focused else sorted(str(p.relative_to(repo)) for p in (repo / 'test').rglob('*.test.js'))
    for name in files:
        if not (repo / name).is_file():
            raise ValueError('Required test missing: ' + name)
    xml = output / 'results.xml'
    env = dict(os.environ, ELECTRON_RUN_AS_NODE='1', REQUIRE_DB_TESTS='1')
    # No provider, GitHub or Claude credentials are needed by application tests.
    for key in list(env):
        if any(x in key.upper() for x in ('TOKEN', 'API_KEY', 'SECRET', 'PASSWORD')):
            env.pop(key)
    cmd = [str(repo / 'node_modules/electron/dist/electron'), '--import', 'tsx', '--test', '--test-concurrency=4', '--test-reporter=junit', '--test-reporter-destination=' + str(xml), *files]
    with (output / 'runner.log').open('w') as log:
        proc = subprocess.run(cmd, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
    if proc.returncode not in (0, 1):
        raise ValueError('Test runner crashed: ' + str(proc.returncode))
    result = read_results(xml)
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
    c = sub.add_parser('compare')
    c.add_argument('baseline')
    c.add_argument('candidate')
    a = p.parse_args()
    if a.command == 'run':
        run(a.repo, a.output, a.focused)
    else:
        report = compare(json.loads(Path(a.baseline).read_text()), json.loads(Path(a.candidate).read_text()))
        print(json.dumps(report, indent=2))
        if any(report[k] for k in ('missing', 'new_failures', 'new_skips')):
            raise ValueError('Candidate introduced test regressions or missing checks')

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
