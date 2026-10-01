"""Static packaging contract tests for the public distribution surface."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


class PackagingContractTests(unittest.TestCase):
    def test_build_inputs_and_runtime_files_are_present(self):
        for relative in (
            'Dockerfile', 'compose.yaml', 'install.sh', '.dockerignore', '.env.example',
            'docker/docker-entrypoint.sh', 'docker/hermes-entrypoint.py',
            'docker/patch-amnesia.sh', 'docker/patch-memory-policy.sh',
            'docker/healthcheck.mjs', 'docs/installation.md',
        ):
            self.assertTrue((ROOT / relative).is_file(), relative)

    def test_private_maintenance_dependencies_and_auth_bypass_are_absent(self):
        files = [ROOT / 'Dockerfile', ROOT / 'compose.yaml', ROOT / 'install.sh', ROOT / '.env.example']
        files += list((ROOT / 'docker').iterdir())
        text = '\n'.join(path.read_text(errors='replace') for path in files)
        for token in ('wrangler', 'pymysql', 'redis', 'sshpass', 'rsync', 'AUTH_DISABLED=1', '/var/run/docker.sock'):
            self.assertNotIn(token, text, token)

    def test_compose_builds_source_and_persists_only_named_app_volumes(self):
        compose = (ROOT / 'compose.yaml').read_text()
        self.assertIn('dockerfile: Dockerfile', compose)
        self.assertIn('context: .', compose)
        self.assertIn('AUTH_DISABLED: "0"', compose)
        self.assertIn('hermes:/home/agent/.hermes', compose)
        self.assertIn('webui:/home/agent/.hermes-web-ui', compose)
        self.assertIn('claude:/home/agent/.claude', compose)
        self.assertIn('pi:/home/agent/.pi', compose)
        self.assertNotIn('docker.sock', compose)
        self.assertNotIn('8642', compose)

    def test_dockerfile_has_runtime_healthcheck_and_no_private_install_block(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertIn('npm run build', dockerfile)
        self.assertIn('agent-browser install --with-deps', dockerfile)
        self.assertIn('HEALTHCHECK', dockerfile)
        self.assertIn('AUTH_DISABLED=0', dockerfile)
        self.assertNotRegex(dockerfile, r'(?i)\b(wrangler|pymysql|redis|sshpass|rsync)\b')


if __name__ == '__main__':
    unittest.main()
