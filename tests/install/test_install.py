"""Installer behavior tests; Docker/curl are fixtures, NOT image verification."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="x-agent-install-test-")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.bin = self.work / "bin"
        self.bin.mkdir()
        self.home = self.work / "home"
        self.home.mkdir()
        self.log = self.work / "calls.jsonl"
        self.archive = self.work / "source.tar.gz"
        self.make_archive()
        self.command("docker", '''import json, os, sys
with open(os.environ["CALLS"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
a = sys.argv[1:]
if a[:1] == ["info"]:
    print(os.environ.get("DAEMON_VERSION", "28.0.0"))
    sys.exit(int(os.environ.get("DAEMON_RC", "0")))
if a[:2] == ["compose", "version"]:
    print(os.environ.get("COMPOSE_VERSION", "2.39.0"))
    sys.exit(int(os.environ.get("COMPOSE_RC", "0")))
if "build" in a:
    sys.exit(int(os.environ.get("BUILD_RC", "0")))
if "up" in a:
    sys.exit(int(os.environ.get("UP_RC", "0")))
''')
        self.command("curl", '''import json, os, shutil, sys
with open(os.environ["CALLS"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
if os.environ.get("CURL_RC"):
    sys.exit(int(os.environ["CURL_RC"]))
a = sys.argv[1:]
assert "https://github.com/gimee/x-agent-webui/archive/refs/heads/main.tar.gz" in a
assert "--proto" in a and "--proto-redir" in a
shutil.copyfile(os.environ["ARCHIVE"], a[a.index("--output") + 1])
''')
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        HOME=str(self.home), TMPDIR=str(self.work), CALLS=str(self.log),
                        ARCHIVE=str(self.archive))
        for key in ("COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "X_AGENT_PORT", "X_AGENT_BIND"):
            self.env.pop(key, None)

    def command(self, name, source):
        target = self.bin / name
        target.write_text("#!" + shutil.which("python3") + "\n" + source)
        target.chmod(0o755)

    def make_archive(self, extra=None, omit=()):
        files = {"Dockerfile": "FROM scratch\n", "compose.yaml": "services: {}\n", ".env.example": "X_AGENT_PORT=6060\nX_AGENT_BIND=127.0.0.1\n", "package.json": "{}\n", "package-lock.json": "{}\n"}
        if extra:
            files.update(extra)
        for name in omit:
            files.pop(name, None)
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, content in files.items():
                entry = tarfile.TarInfo("x-agent-webui-main/" + name)
                data = content.encode()
                entry.size = len(data)
                entry.mode = 0o644
                archive.addfile(entry, io.BytesIO(data))

    def run_install(self, *args, **environment):
        self.assertTrue((ROOT / "install.sh").is_file(), "install.sh must exist")
        return subprocess.run([shutil.which("bash"), "-s", "--", *args], input=(ROOT / "install.sh").read_text(),
                              cwd=self.home, env=dict(self.env, **environment), capture_output=True,
                              text=True, timeout=15)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_installs_main_archive_and_builds_before_waiting(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        target = self.home / "x-agent-webui"
        self.assertTrue((target / "Dockerfile").is_file())
        env = (target / ".env").read_text()
        self.assertIn("X_AGENT_PORT=6060\n", env)
        self.assertIn("X_AGENT_BIND=127.0.0.1\n", env)
        self.assertEqual((target / ".env").stat().st_mode & 0o777, 0o600)
        calls = self.calls()
        build = next(i for i, args in enumerate(calls) if "build" in args)
        up = next(i for i, args in enumerate(calls) if "up" in args)
        self.assertLess(build, up)
        self.assertIn("--pull", calls[build])
        self.assertIn("--no-build", calls[up])
        self.assertIn("--wait", calls[up])
        self.assertIn("--wait-timeout", calls[up])
        self.assertIn("http://127.0.0.1:6060", result.stdout)
        self.assertFalse(any("down" in args for args in calls))

    def test_rejects_non_empty_directory_without_docker_or_network(self):
        target = self.home / "existing"
        target.mkdir()
        (target / "keep.txt").write_text("keep")
        result = self.run_install("--dir", str(target))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("non-empty", result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual((target / "keep.txt").read_text(), "keep")

    def test_rejects_empty_daemon_output_even_when_docker_info_returns_zero(self):
        result = self.run_install(DAEMON_VERSION="")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no valid server version", result.stderr)
        self.assertFalse(self.calls() and any("build" in args for args in self.calls()))

    def test_custom_safe_options_are_written_to_env(self):
        target = self.home / "custom"
        result = self.run_install("--dir", str(target), "--port", "6123", "--bind", "::1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("X_AGENT_PORT=6123\n", (target / ".env").read_text())
        self.assertIn("X_AGENT_BIND=::1\n", (target / ".env").read_text())
        self.assertIn("http://[::1]:6123", result.stdout)

    def test_download_failure_never_creates_installation_directory(self):
        result = self.run_install(CURL_RC="22")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.home / "x-agent-webui").exists())
        self.assertTrue(any("https://github.com/gimee/x-agent-webui/archive/refs/heads/main.tar.gz" in args for args in self.calls()))
        self.assertFalse(any("build" in args for args in self.calls()))

    def test_truncated_download_never_starts_installation(self):
        source = (ROOT / "install.sh").read_text().split("printf 'X_AGENT_PORT=")[0]
        result = subprocess.run([shutil.which("bash"), "-s"], input=source, cwd=self.home,
                                env=self.env, text=True, capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])
        self.assertEqual(list(self.home.iterdir()), [])

    def test_invalid_arguments_are_rejected_before_side_effects(self):
        for args in [("--port", "0"), ("--port", "65536"), ("--port", "06060"),
                     ("--port", "$(touch injected)"), ("--port", "6060\nCOMPOSE_PROFILES=evil"),
                     ("--bind", "localhost"), ("--bind", "127.0.0.999"), ("--bind", "::1;id"),
                     ("--bind", "fe80::1%eth0"), ("--dir", "bad\nname"), ("--port",),
                     ("--dir", ""), ("--dir", "--port"), ("--unknown",)]:
            with self.subTest(args=args):
                result = self.run_install(*args)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("Error:", result.stderr)
                self.assertEqual(self.calls(), [])
                self.assertEqual(list(self.home.iterdir()), [])

    def test_missing_docker_is_reported_without_installing_it(self):
        (self.bin / "docker").unlink()
        (self.bin / "python3").symlink_to(shutil.which("python3"))
        result = self.run_install(PATH=str(self.bin))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing dependency: docker", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_missing_or_old_compose_is_rejected(self):
        for env in ({"COMPOSE_RC": "1"}, {"COMPOSE_VERSION": ""}, {"COMPOSE_VERSION": "1.29.2"}, {"COMPOSE_VERSION": "2.19.9"}):
            with self.subTest(env=env):
                result = self.run_install(**env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Compose", result.stderr)
                self.assertEqual(list(self.home.iterdir()), [])
                self.assertFalse(any("build" in args for args in self.calls()))

    def test_daemon_failure_is_rejected(self):
        result = self.run_install(DAEMON_RC="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker daemon", result.stderr)
        self.assertEqual(list(self.home.iterdir()), [])

    def test_symlink_and_regular_file_targets_are_rejected(self):
        target = self.home / "link"
        target.symlink_to(self.work, target_is_directory=True)
        result = self.run_install("--dir", str(target))
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(target.is_symlink())
        target.unlink()
        target.write_text("untouched")
        result = self.run_install("--dir", str(target))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), "untouched")
        self.assertEqual(self.calls(), [])

    def test_directory_metacharacters_are_literal(self):
        target = self.home / 'spaces ; $(touch INJECTED) $HOME'
        result = self.run_install("--dir", str(target))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((target / "Dockerfile").is_file())
        self.assertEqual(list(self.home.iterdir()), [target])
        self.assertFalse((self.home / "INJECTED").exists())

    def test_build_failure_keeps_sources_and_never_starts_containers(self):
        result = self.run_install(BUILD_RC="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Source build failed", result.stderr)
        self.assertTrue((self.home / "x-agent-webui/.env").is_file())
        self.assertFalse(any("up" in args or "down" in args for args in self.calls()))

    def test_startup_failure_is_not_reported_as_success(self):
        result = self.run_install(UP_RC="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Startup/health verification failed", result.stderr)
        self.assertNotIn("health checks passed", result.stdout)
        self.assertTrue((self.home / "x-agent-webui/Dockerfile").is_file())
        self.assertFalse(any("down" in args for args in self.calls()))

    def test_second_install_refuses_and_preserves_first_env(self):
        first = self.run_install()
        self.assertEqual(first.returncode, 0, first.stderr)
        before = (self.home / "x-agent-webui/.env").read_bytes()
        calls_before = self.calls()
        second = self.run_install("--port", "9999")
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual((self.home / "x-agent-webui/.env").read_bytes(), before)
        self.assertEqual(self.calls(), calls_before)

    def test_non_loopback_requires_a_strong_default_credential_warning(self):
        result = self.run_install("--bind", "0.0.0.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WARNING:", result.stderr)
        self.assertIn("public defaults", result.stderr)
        self.assertIn("not a secure public deployment", result.stderr)
        self.assertIn("change the username and password", result.stderr)

    def test_archive_traversal_is_rejected_without_writing_target(self):
        self.make_archive({"../escaped": "unsafe"})
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe or unexpected archive", result.stderr)
        self.assertFalse((self.home / "x-agent-webui").exists())
        self.assertFalse((self.home / "escaped").exists())

    def test_archive_links_are_rejected(self):
        with tarfile.open(self.archive, "w:gz") as archive:
            member = tarfile.TarInfo("x-agent-webui-main/escape")
            member.type = tarfile.SYMTYPE
            member.linkname = "../../escaped"
            archive.addfile(member)
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("links and special files", result.stderr)
        self.assertFalse((self.home / "x-agent-webui").exists())

    def test_archive_env_cannot_override_local_configuration(self):
        self.make_archive({".env": "X_AGENT_BIND=0.0.0.0"})
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("local configuration", result.stderr)
        self.assertFalse((self.home / "x-agent-webui").exists())

    def test_empty_directory_is_supported(self):
        target = self.home / "empty"
        target.mkdir()
        result = self.run_install("--dir", str(target))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((target / ".env").is_file())

    def test_archive_missing_lockfile_is_rejected_before_extraction(self):
        self.make_archive(omit=("package-lock.json",))
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing required source/build files", result.stderr)
        self.assertFalse((self.home / "x-agent-webui").exists())

    def test_help_has_no_side_effects(self):
        result = self.run_install("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--dir", result.stdout)
        self.assertIn("--port", result.stdout)
        self.assertIn("--bind", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assertEqual(list(self.home.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
