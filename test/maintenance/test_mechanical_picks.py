"""Tests for the pick-based maintenance flow: classification -> trusted mechanical application
-> conflict editor -> candidate, using real temporary git repositories and no network.

Run: python3 -m unittest discover -s test/maintenance -p 'test_mechanical_picks.py'
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'upstream-maintenance.py'
spec = importlib.util.spec_from_file_location('upstream_maintenance_picks', SCRIPT)
um = importlib.util.module_from_spec(spec)
spec.loader.exec_module(um)

IDENT = {
    'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
    'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid',
    'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
}
BRANCH = 'feat/byok-cleanup'
STATE = '.github/upstream-maintenance-state.json'
PACKAGE = {
    'name': 'open-whispr', 'version': '1.0.0',
    'scripts': {'typecheck': 'cd src && tsc --noEmit', 'lint': 'eslint .',
                'build:renderer': 'cd src && vite build', 'test': 'node --test',
                'postinstall': 'electron-builder install-app-deps', 'dev': 'vite'},
    'dependencies': {'left-pad': '1.0.0'},
}
POLICY = {'schema_version': 1, 'protected_tests': ['test/helpers/fork.test.js']}


def git(cwd, *args, input=None, check=True):
    p = subprocess.run(['git', *args], cwd=str(cwd), env=dict(os.environ, **IDENT), input=input,
                       capture_output=True, check=False)
    if check and p.returncode:
        raise AssertionError('git %s failed: %s' % (' '.join(args), p.stderr.decode()))
    return p.stdout.decode().strip() if input is None or isinstance(input, str) else p.stdout


def write(root, rel, text='x\n', mode=None):
    path = Path(root) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text)
    if mode is not None:
        path.chmod(mode)
    return path


def lines(prefix, n=8):
    return ''.join('%s%d\n' % (prefix, i) for i in range(1, n + 1))


def replace_line(text, number, value):
    rows = text.splitlines(keepends=True)
    rows[number - 1] = value + '\n'
    return ''.join(rows)


def cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            rc = um.main([str(a) for a in argv])
        except SystemExit as e:
            rc = e.code
    return rc, out.getvalue(), err.getvalue()


class World(unittest.TestCase):
    """Upstream with one commit per scenario on top of u0; a personal fork that diverged from u0."""

    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='um-picks-'))
        up = cls.up = cls.root / 'up'
        up.mkdir()
        git(up, 'init', '-q', '-b', 'main')
        write(up, 'package.json', json.dumps(PACKAGE, indent=2) + '\n')
        write(up, 'src/app.js', lines('a'))
        write(up, 'src/fork.js', lines('f'))
        write(up, 'src/util.js', lines('u'))
        write(up, 'src/rename_me.js', lines('r'))
        write(up, 'test/core.test.js', 'core\n')
        write(up, 'test/helpers/fork.test.js', 'fork test\n')
        write(up, 'CLAUDE.md', '# upstream claude\n')
        write(up, '.gitignore', 'node_modules\n')
        write(up, 'docs/readme.md', 'docs\n')
        git(up, 'add', '-A')
        git(up, 'commit', '-q', '-m', 'u0')
        cls.u0 = git(up, 'rev-parse', 'HEAD')
        cls.source = cls.root / 'source'
        git(cls.root, 'clone', '-q', str(up), str(cls.source))
        s = cls.source
        git(s, 'checkout', '-q', '-b', BRANCH)
        write(s, 'src/fork.js', replace_line(lines('f'), 2, 'f2-fork'))
        git(s, 'mv', 'src/rename_me.js', 'src/renamed_by_fork.js')
        write(s, '.gitignore', 'node_modules\nvendor-ignored/\n')
        write(s, 'FORK.md', '# fork\n')
        write(s, '.github/personal-fork-policy.json', json.dumps(POLICY))
        write(s, '.github/workflows/ci.yml', 'name: ci\n')
        write(s, 'scripts/upstream-maintenance.py', '# helper\n')
        write(s, 'test/maintenance/test_x.py', '# t\n')
        git(s, 'add', '-A')
        git(s, 'commit', '-q', '-m', 'personal fork')
        cls.base = git(s, 'rev-parse', 'HEAD')

        def commit(message, edits=(), removes=(), links=()):
            for rel, text, *mode in edits:
                write(up, rel, text, mode[0] if mode else None)
            for rel in removes:
                git(up, 'rm', '-q', rel)
            for rel, target in links:
                (up / rel).parent.mkdir(parents=True, exist_ok=True)
                os.symlink(target, up / rel)
            git(up, 'add', '-A', '-f')
            git(up, 'commit', '-q', '-m', message)
            return git(up, 'rev-parse', 'HEAD')

        c = cls.c = {}
        c['clean'] = commit('fix util', [('src/util.js', replace_line(lines('u'), 3, 'u3-up'))])
        c['conflict'] = commit('fix fork and app', [
            ('src/fork.js', replace_line(lines('f'), 2, 'f2-up')),
            ('src/app.js', replace_line(lines('a'), 1, 'a1-up'))])
        c['conflict_only'] = commit('fix fork more', [
            ('src/fork.js', replace_line(replace_line(lines('f'), 2, 'f2-up'), 3, 'f3-up'))])
        c['protected_code'] = commit('code with protected test', [
            ('src/app.js', replace_line(replace_line(lines('a'), 1, 'a1-up'), 8, 'a8-up')),
            ('test/helpers/fork.test.js', 'fork test changed\n'),
            ('.github/workflows/ci.yml', 'name: upstream ci\n')])
        c['ignorable'] = commit('docs and instructions', [
            ('CLAUDE.md', '# upstream claude v2\n'),
            ('.github/workflows/other.yml', 'name: other\n'),
            ('docs/readme.md', 'docs v2\n')])
        scripts = json.loads(json.dumps(PACKAGE))
        scripts['scripts']['typecheck'] = 'true'
        scripts['dependencies']['left-pad'] = '1.1.0'
        c['package_only'] = commit('weaken typecheck', [('package.json', json.dumps(scripts, indent=2) + '\n')])
        c['deleted_test'] = commit('drop core test', [('src/util.js', replace_line(
            replace_line(lines('u'), 3, 'u3-up'), 6, 'u6-up'))], removes=['test/core.test.js'])
        c['ignored_add'] = commit('vendor files', [('vendor-ignored/lib.js', 'vendored\n')])
        c['symlink'] = commit('link', [('src/new.js', 'new\n')], links=[('docs/link', 'readme.md')])
        c['exec_binary'] = commit('tool', [('src/tool.sh', '#!/bin/sh\n', 0o755),
                                           ('src/blob.bin', bytes(range(256)))])
        c['rename'] = commit('fix renamed file', [('src/rename_me.js', replace_line(lines('r'), 7, 'r7-up'))])
        cls.tip = git(up, 'rev-parse', 'HEAD')
        # merge shape: side branch and main branch joined by a merge commit
        git(up, 'checkout', '-q', '-b', 'side')
        c['side'] = commit('side work', [('src/side.js', 'side\n')])
        git(up, 'checkout', '-q', 'main')
        c['main2'] = commit('main work', [('src/main2.js', 'main2\n')])
        git(up, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
        c['merge'] = git(up, 'rev-parse', 'HEAD')
        cls.merge_tip = c['merge']
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        type(self).n += 1
        self.work = self.root / ('case%d' % self.n)
        self.work.mkdir()

    # -- helpers
    def clone(self, name='repo'):
        dest = self.work / name
        git(self.work, 'clone', '-q', str(self.source), str(dest))
        git(dest, 'checkout', '-q', BRANCH)
        git(dest, 'fetch', '-q', '--no-tags', str(self.up), '+main:refs/upstream-maintenance/release')
        return dest

    def context(self, repo, shas=None, previous=None, upstream=None, name='context.json'):
        previous = previous or self.u0
        upstream = upstream or self.tip
        order = git(repo, 'rev-list', '--reverse', '--topo-order', '%s..%s' % (previous, upstream)).split()
        subjects = {s: git(repo, 'log', '-1', '--format=%s', s) for s in order}
        ctx = {'base_sha': self.base, 'release_tag': 'v1.0.1', 'upstream_sha': upstream,
               'previous_upstream': previous, 'pending': True,
               'commits': [{'sha': s, 'subject': subjects[s]} for s in order]}
        path = self.work / name
        path.write_text(json.dumps(ctx))
        return path, ctx

    def result(self, ctx, select, name='result.json'):
        selected = [c['sha'] for c in ctx['commits'] if c['sha'] in select]
        skipped = [{'sha': c['sha'], 'reason': 'not relevant'} for c in ctx['commits'] if c['sha'] not in select]
        path = self.work / name
        path.write_text(json.dumps({'complete': True, 'selected': selected, 'skipped': skipped,
                                    'summary': 'classified'}))
        return path

    def apply(self, select, name='repo', **kw):
        repo = self.clone(name)
        ctx_path, ctx = self.context(repo, **kw)
        result = self.result(ctx, {self.c[k] if k in self.c else k for k in select})
        report_path = self.work / (name + '-report.json')
        rc, out, err = cli('apply-selected', '--repo', repo, '--context', ctx_path, '--result', result,
                           '--report', report_path)
        report = json.loads(report_path.read_text()) if report_path.exists() else None
        return repo, ctx_path, ctx, result, report_path, report, rc, out, err

    def entry(self, report, key):
        return next(e for e in report['commits'] if e['sha'] == self.c[key])

    def editor(self, resolved=(), skipped=(), complete=True, name='editor.json'):
        path = self.work / name
        path.write_text(json.dumps({
            'complete': complete, 'resolved': [self.c[k] if k in self.c else k for k in resolved],
            'skipped': [{'sha': self.c[k] if k in self.c else k, 'reason': 'obsolete'} for k in skipped],
            'summary': 'edited'}))
        return path

    def candidate(self, repo, ctx_path, result, editor=None, name='candidate.patch'):
        patch = self.work / name
        args = ['candidate', '--repo', repo, '--context', ctx_path, '--result', result, '--patch', patch]
        if editor:
            args += ['--editor-result', editor]
        rc, out, err = cli(*args)
        return rc, out, err, patch


class MechanicalApplicationTests(World):
    def test_clean_commit_is_applied_without_the_editor(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['clean', 'rename'])
        self.assertEqual(rc, 0, err)
        self.assertEqual(report['attention'], [])
        self.assertEqual((repo / 'src/util.js').read_text().splitlines()[2], 'u3-up')
        # upstream's edit follows the fork's rename (Git rename detection)
        self.assertEqual((repo / 'src/renamed_by_fork.js').read_text().splitlines()[6], 'r7-up')
        self.assertFalse((repo / 'src/rename_me.js').exists())
        self.assertEqual(git(repo, 'rev-parse', 'HEAD'), self.base)

    def test_unselected_commits_are_never_applied(self):
        repo, *_rest, rc, out, err = self.apply(['clean'])
        self.assertEqual(rc, 0, err)
        self.assertEqual((repo / 'src/app.js').read_text(), lines('a'))
        self.assertFalse((repo / 'src/tool.sh').exists())

    def test_conflicting_file_is_left_unchanged_and_never_gets_markers(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict'])
        self.assertEqual(rc, 0, err)
        e = self.entry(report, 'conflict')
        self.assertEqual((e['status'], e['conflicts'], e['applied']), ('partial', ['src/fork.js'], ['src/app.js']))
        self.assertEqual(report['attention'], [self.c['conflict']])
        self.assertEqual((repo / 'src/fork.js').read_text().splitlines()[1], 'f2-fork')
        self.assertEqual((repo / 'src/app.js').read_text().splitlines()[0], 'a1-up')
        for path in repo.rglob('*'):
            if path.is_file() and '.git' not in path.parts:
                self.assertNotIn(b'<<<<<<<', path.read_bytes(), str(path))

    def test_fully_conflicting_commit_is_unapplied(self):
        *_a, report, rc, out, err = self.apply(['conflict_only'])
        self.assertEqual(rc, 0, err)
        e = self.entry(report, 'conflict_only')
        self.assertEqual((e['status'], e['applied']), ('unapplied', []))

    def test_protected_hunks_are_not_applied_but_code_is(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['protected_code'])
        self.assertEqual(rc, 0, err)
        e = self.entry(report, 'protected_code')
        self.assertEqual(e['status'], 'applied')
        self.assertEqual(e['protected'], ['.github/workflows/ci.yml', 'test/helpers/fork.test.js'])
        self.assertEqual(e['applied'], ['src/app.js'])
        self.assertEqual((repo / 'test/helpers/fork.test.js').read_text(), 'fork test\n')
        self.assertEqual((repo / '.github/workflows/ci.yml').read_text(), 'name: ci\n')
        self.assertEqual((repo / 'src/app.js').read_text().splitlines()[7], 'a8-up')
        # a dropped protected *test* may require adapting other code; workflows do not
        self.assertEqual(report['attention'], [self.c['protected_code']])

    def test_instruction_and_workflow_only_changes_need_no_editor(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['ignorable'])
        self.assertEqual(rc, 0, err)
        e = self.entry(report, 'ignorable')
        self.assertEqual(sorted(e['protected']), ['.github/workflows/other.yml', 'CLAUDE.md'])
        self.assertEqual(e['applied'], ['docs/readme.md'])
        self.assertEqual(report['attention'], [])
        self.assertFalse((repo / '.github/workflows/other.yml').exists())
        self.assertEqual((repo / 'CLAUDE.md').read_text(), '# upstream claude\n')

    def test_pinned_package_scripts_are_never_taken_from_upstream(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['package_only'])
        self.assertEqual(rc, 0, err)
        e = self.entry(report, 'package_only')
        self.assertEqual((e['status'], e['applied'], e['guard_paths']), ('unapplied', [], ['package.json']))
        self.assertIn('typecheck', e['guard'][0])
        pkg = json.loads((repo / 'package.json').read_text())
        self.assertEqual(pkg['scripts']['typecheck'], PACKAGE['scripts']['typecheck'])
        self.assertEqual(pkg['dependencies']['left-pad'], '1.0.0')
        self.assertEqual(report['attention'], [self.c['package_only']])

    def test_deleted_tests_are_kept(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['deleted_test'])
        self.assertEqual(rc, 0, err)
        self.assertEqual((repo / 'test/core.test.js').read_text(), 'core\n')
        e = self.entry(report, 'deleted_test')
        self.assertEqual(e['kept_tests'], ['test/core.test.js'])
        self.assertEqual((repo / 'src/util.js').read_text().splitlines()[5], 'u6-up')
        self.assertEqual(e['status'], 'applied')

    def test_symlinks_are_not_applied(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['symlink'])
        self.assertEqual(rc, 0, err)
        self.assertFalse(os.path.lexists(repo / 'docs/link'))
        e = self.entry(report, 'symlink')
        self.assertEqual((e['status'], e['applied'], e['guard_paths']), ('partial', ['src/new.js'], ['docs/link']))

    def test_files_matching_fork_ignore_rules_are_tracked_not_rejected(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['ignored_add'])
        self.assertEqual(rc, 0, err)
        self.assertEqual((repo / 'vendor-ignored/lib.js').read_text(), 'vendored\n')
        self.assertEqual(git(repo, 'ls-files', 'vendor-ignored'), 'vendor-ignored/lib.js')
        # files the editor adds there later are still ignored build output
        write(repo, 'vendor-ignored/extra.js', 'x\n')
        rc, out, err, patch = self.candidate(repo, ctx_path, result)
        self.assertEqual(rc, 1)
        self.assertIn('ignored', err)

    def test_executable_and_binary_files_survive(self):
        repo, *_rest, rc, out, err = self.apply(['exec_binary'])
        self.assertEqual(rc, 0, err)
        self.assertEqual((repo / 'src/blob.bin').read_bytes(), bytes(range(256)))
        self.assertTrue(os.stat(repo / 'src/tool.sh').st_mode & stat.S_IXUSR)

    def test_merge_commits_need_the_editor(self):
        repo = self.clone()
        ctx_path, ctx = self.context(repo, previous=self.tip, upstream=self.merge_tip)
        result = self.result(ctx, {c['sha'] for c in ctx['commits']})
        report_path = self.work / 'r.json'
        rc, out, err = cli('apply-selected', '--repo', repo, '--context', ctx_path, '--result', result,
                           '--report', report_path)
        self.assertEqual(rc, 0, err)
        report = json.loads(report_path.read_text())
        self.assertEqual([e['status'] for e in report['commits'] if e['sha'] == self.c['merge']], ['unapplied'])
        self.assertIn(self.c['merge'], report['attention'])
        self.assertTrue((repo / 'src/side.js').exists() and (repo / 'src/main2.js').exists())

    def test_dirty_checkout_is_refused(self):
        repo = self.clone()
        write(repo, 'src/app.js', 'dirty\n')
        ctx_path, ctx = self.context(repo)
        result = self.result(ctx, {self.c['clean']})
        rc, out, err = cli('apply-selected', '--repo', repo, '--context', ctx_path, '--result', result,
                           '--report', self.work / 'r.json')
        self.assertEqual(rc, 1)
        self.assertFalse((self.work / 'r.json').exists())

    def test_report_inside_repo_is_refused(self):
        repo = self.clone()
        ctx_path, ctx = self.context(repo)
        result = self.result(ctx, {self.c['clean']})
        rc, *_ = cli('apply-selected', '--repo', repo, '--context', ctx_path, '--result', result,
                     '--report', repo / 'report.json')
        self.assertEqual(rc, 1)

    def test_bad_classification_is_refused_before_any_change(self):
        repo = self.clone()
        ctx_path, ctx = self.context(repo)
        bad = self.work / 'bad.json'
        bad.write_text(json.dumps({'complete': True, 'selected': [self.c['clean']], 'skipped': [],
                                   'summary': 's'}))
        rc, *_ = cli('apply-selected', '--repo', repo, '--context', ctx_path, '--result', bad,
                     '--report', self.work / 'r.json')
        self.assertEqual(rc, 1)
        self.assertEqual(git(repo, 'status', '--porcelain'), '')
        self.assertEqual(cli('check-result', '--repo', repo, '--context', ctx_path, '--result', bad)[0], 1)
        good = self.result(ctx, {self.c['clean']})
        self.assertEqual(cli('check-result', '--repo', repo, '--context', ctx_path, '--result', good)[0], 0)

    def test_plan_is_deterministic(self):
        repo = self.clone()
        ctx_path, ctx = self.context(repo)
        everything = [c['sha'] for c in ctx['commits']]
        first = um.mechanical_plan(repo, ctx, everything)
        second = um.mechanical_plan(repo, ctx, everything)
        self.assertEqual(first, second)


class CandidateWithEditorTests(World):
    def test_no_attention_needs_no_editor_and_rejects_one(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['clean', 'ignorable'])
        self.assertEqual(rc, 0, err)
        rc, out, err, patch = self.candidate(repo, ctx_path, result)
        self.assertEqual(rc, 0, err)
        state = json.loads((repo / STATE).read_text())
        self.assertEqual(state['selected'], [self.c['clean'], self.c['ignorable']])
        self.assertEqual(len(state['skipped']), len(ctx['commits']) - 2)
        rc, out, err, _ = self.candidate(repo, ctx_path, result, self.editor(), 'again.patch')
        self.assertEqual(rc, 1)
        self.assertIn('no commit needs the editor', err)

    def test_attention_requires_an_editor_result(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict'])
        rc, out, err, patch = self.candidate(repo, ctx_path, result)
        self.assertEqual(rc, 1)
        self.assertIn('conflict editor', err)
        self.assertFalse(patch.exists())

    def test_report_is_not_trusted_by_candidate(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict'])
        report['attention'] = []
        report['commits'][0]['status'] = 'applied'
        rp.write_text(json.dumps(report))
        rc, out, err, patch = self.candidate(repo, ctx_path, result)
        self.assertEqual(rc, 1)

    def test_resolved_conflict_produces_a_patch_that_replays(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict', 'clean'])
        write(repo, 'src/fork.js', replace_line(lines('f'), 2, 'f2-fork+up'))  # editor's merge
        rc, out, err, patch = self.candidate(repo, ctx_path, result, self.editor(['conflict']))
        self.assertEqual(rc, 0, err)
        state = json.loads((repo / STATE).read_text())
        self.assertEqual(state['selected'], [self.c['clean'], self.c['conflict']])
        verifier = self.clone('verifier')
        rc, tree, err = cli('check-patch', '--repo', verifier, '--base', self.base, '--patch', patch,
                            '--context', ctx_path)
        self.assertEqual(rc, 0, err)
        self.assertEqual(tree.strip(), json.loads(out)['tree'])
        self.assertEqual((verifier / 'src/fork.js').read_text().splitlines()[1], 'f2-fork+up')

    def test_replay_keeps_files_matching_fork_ignore_rules(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['ignored_add'])
        rc, out, err, patch = self.candidate(repo, ctx_path, result)
        self.assertEqual(rc, 0, err)
        verifier = self.clone('verifier')
        rc, tree, err = cli('check-patch', '--repo', verifier, '--base', self.base, '--patch', patch,
                            '--context', ctx_path)
        self.assertEqual(rc, 0, err)
        self.assertEqual((verifier / 'vendor-ignored/lib.js').read_text(), 'vendored\n')

    def test_unapplied_commit_may_be_skipped_by_the_editor_with_a_reason(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict_only', 'clean'])
        rc, out, err, patch = self.candidate(repo, ctx_path, result, self.editor(skipped=['conflict_only']))
        self.assertEqual(rc, 0, err)
        state = json.loads((repo / STATE).read_text())
        self.assertEqual(state['selected'], [self.c['clean']])
        reasons = {s['sha']: s['reason'] for s in state['skipped']}
        self.assertEqual(reasons[self.c['conflict_only']], 'conflict editor: obsolete')
        self.assertEqual(reasons[self.c['protected_code']], 'not relevant')
        self.assertEqual(len(state['selected']) + len(state['skipped']), len(ctx['commits']))

    def test_partly_applied_commit_cannot_be_skipped(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict'])
        rc, out, err, patch = self.candidate(repo, ctx_path, result, self.editor(skipped=['conflict']))
        self.assertEqual(rc, 1)
        self.assertIn('partly applied', err)

    def test_malformed_editor_results_are_refused(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict', 'package_only'])
        a, b = self.c['conflict'], self.c['package_only']
        good = {'complete': True, 'resolved': [a, b], 'skipped': [], 'summary': 's'}
        cases = {
            'incomplete': dict(good, complete=False),
            'complete not bool': dict(good, complete='true'),
            'missing commit': dict(good, resolved=[a]),
            'extra commit': dict(good, resolved=[a, b, self.c['clean']]),
            'unknown commit': dict(good, resolved=[a, 'c' * 40]),
            'duplicate': dict(good, resolved=[a, a, b]),
            'resolved and skipped': dict(good, skipped=[{'sha': b, 'reason': 'r'}]),
            'abbreviated': dict(good, resolved=[a[:12], b]),
            'empty skip reason': dict(good, resolved=[a], skipped=[{'sha': b, 'reason': ''}]),
            'summary empty': dict(good, summary=' '),
            'unexpected key': dict(good, extra=1),
            'not an object': [good],
        }
        for name, data in cases.items():
            with self.subTest(name):
                path = self.work / 'e.json'
                path.write_text(json.dumps(data))
                rc, out, err, patch = self.candidate(repo, ctx_path, result, path)
                self.assertEqual(rc, 1, name)
                self.assertFalse(patch.exists(), name)
        path = self.work / 'ok.json'
        path.write_text(json.dumps(good))
        rc, out, err, patch = self.candidate(repo, ctx_path, result, path)
        self.assertEqual(rc, 0, err)

    def test_editor_cannot_touch_protected_paths(self):
        for rel in ('test/helpers/fork.test.js', 'FORK.md', '.github/workflows/ci.yml', 'CLAUDE.md',
                    'test/maintenance/test_x.py', STATE, '.claude/settings.json'):
            with self.subTest(rel):
                repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(
                    ['conflict'], name='repo-' + str(abs(hash(rel))))
                write(repo, rel, 'tampered\n')
                rc, out, err, patch = self.candidate(repo, ctx_path, result, self.editor(['conflict']))
                self.assertEqual(rc, 1)
                self.assertFalse(patch.exists())

    def test_editor_cannot_weaken_package_scripts(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['package_only'])
        pkg = json.loads((repo / 'package.json').read_text())
        pkg['scripts']['lint'] = 'true'
        write(repo, 'package.json', json.dumps(pkg))
        rc, out, err, patch = self.candidate(repo, ctx_path, result, self.editor(['package_only']))
        self.assertEqual(rc, 1)
        self.assertIn('package.json', err)

    def test_editor_cannot_delete_tests(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict'])
        (repo / 'test/core.test.js').unlink()
        rc, out, err, patch = self.candidate(repo, ctx_path, result, self.editor(['conflict']))
        self.assertEqual(rc, 1)
        self.assertIn('tests', err)


class GitMetadataTests(World):
    def refused(self, mutate, name='repo'):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['clean'], name=name)
        mutate(repo)
        rc, out, err, patch = self.candidate(repo, ctx_path, result)
        self.assertEqual(rc, 1, err)
        self.assertFalse(patch.exists())
        return err

    def test_info_attributes_are_refused(self):
        err = self.refused(lambda r: write(r, '.git/info/attributes', '* filter=evil\n'))
        self.assertIn('attributes', err)

    def test_hooks_are_refused(self):
        err = self.refused(lambda r: write(r, '.git/hooks/pre-commit', '#!/bin/sh\n', 0o755))
        self.assertIn('hook', err)

    def test_risky_config_is_refused(self):
        for key in ('filter.evil.clean', 'core.fsmonitor', 'core.hooksPath', 'alias.x',
                    'diff.evil.textconv', 'merge.evil.driver', 'include.path'):
            with self.subTest(key):
                err = self.refused(lambda r, key=key: git(r, 'config', '--local', key, 'true'),
                                   name='repo-' + key.replace('.', '-'))
                self.assertIn('not allowed', err)

    def test_ordinary_action_config_is_accepted(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['clean'])
        git(repo, 'config', '--local', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
        git(repo, 'config', '--local', 'user.name', 'github-actions[bot]')
        rc, out, err, patch = self.candidate(repo, ctx_path, result)
        self.assertEqual(rc, 0, err)


class ExportTests(World):
    def test_digest_and_patches_cover_every_commit(self):
        repo = self.clone()
        ctx_path, ctx = self.context(repo)
        out_dir = self.work / 'up'
        rc, out, err = cli('export-upstream', '--repo', repo, '--context', ctx_path, '--output', out_dir)
        self.assertEqual(rc, 0, err)
        digest = (out_dir / 'digest.md').read_text()
        for commit in ctx['commits']:
            self.assertIn(commit['sha'], digest)
            self.assertIn(commit['subject'], digest)
            self.assertTrue((out_dir / (commit['sha'] + '.patch')).is_file())
        self.assertRegex(digest, r'\[P\]\[T\] test/helpers/fork\.test\.js')
        self.assertIn('src/fork.js', (out_dir / (self.c['conflict'] + '.patch')).read_text())

    def test_export_inside_repo_is_refused(self):
        repo = self.clone()
        ctx_path, ctx = self.context(repo)
        rc, *_ = cli('export-upstream', '--repo', repo, '--context', ctx_path, '--output', repo / 'out')
        self.assertEqual(rc, 1)

    def test_attention_export_is_limited_to_the_unresolved_paths(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict', 'clean'])
        out_dir = self.work / 'focus'
        rc, out, err = cli('export-upstream', '--repo', repo, '--context', ctx_path, '--output', out_dir,
                           '--only-attention', rp)
        self.assertEqual(rc, 0, err)
        self.assertEqual(sorted(p.name for p in out_dir.iterdir()), sorted([self.c['conflict'] + '.patch', 'digest.md']))
        text = (out_dir / (self.c['conflict'] + '.patch')).read_text()
        patch = text.split('PATCH (', 1)[1]
        self.assertIn('f2-up', patch)
        self.assertNotIn('a1-up', patch)  # applied mechanically; not the editor's work

    def test_attention_export_rejects_foreign_commits(self):
        repo, ctx_path, ctx, result, rp, report, rc, out, err = self.apply(['conflict'])
        report['attention'] = ['d' * 40]
        rp.write_text(json.dumps(report))
        rc, *_ = cli('export-upstream', '--repo', repo, '--context', ctx_path, '--output',
                     self.work / 'x', '--only-attention', rp)
        self.assertEqual(rc, 1)


class ProtectedPathsTests(World):
    def test_lists_every_guarded_path_and_builds_deny_rules(self):
        repo = self.clone()
        out_dir = self.work / 'prot'
        rc, out, err = cli('protected-paths', '--repo', repo, '--base', self.base, '--output', out_dir)
        self.assertEqual(rc, 0, err)
        text = (out_dir / 'protected-paths.txt').read_text()
        for needle in ('FORK.md', 'CLAUDE.md', 'scripts/upstream-maintenance.py', '.npmrc', 'eslint.config.js',
                       'src/tsconfig.json', 'src/vite.config.mjs', 'test/lib/**', 'test/helpers/harness/**',
                       '.github/**', 'test/maintenance/**', 'test/helpers/fork.test.js', 'typecheck'):
            self.assertIn(needle, text)
        rules = (out_dir / 'deny-rules.txt').read_text().split(',')
        for rule in ('Edit(/.git/**)', 'Edit(/.github/**)', 'Edit(/FORK.md)', 'Edit(/.npmrc)',
                     'Edit(/test/lib/**)', 'Edit(/test/helpers/fork.test.js)', 'Edit(**/CLAUDE.md)'):
            self.assertIn(rule, rules)
        self.assertTrue(all(r.startswith('Edit(') and r.endswith(')') for r in rules))

    def test_policy_paths_that_cannot_be_a_literal_rule_are_refused(self):
        repo = self.clone()
        for index, odd in enumerate(('test/a b.test.js', 'test/a,b.test.js', 'test/a(b).test.js')):
            with self.subTest(odd):
                write(repo, '.github/personal-fork-policy.json', json.dumps(dict(POLICY, protected_tests=[odd])))
                git(repo, 'commit', '-qam', 'odd policy %d' % index)
                rc, *_ = cli('protected-paths', '--repo', repo, '--base', git(repo, 'rev-parse', 'HEAD'),
                             '--output', self.work / ('p%d' % index))
                self.assertEqual(rc, 1)


if __name__ == '__main__':
    unittest.main()
