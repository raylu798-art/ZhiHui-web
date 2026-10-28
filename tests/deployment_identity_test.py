"""Exercise the deployed validators themselves; standard library, Python 3.6+."""
import contextlib
import copy
import hashlib
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import unittest


DEPLOY = (pathlib.Path(__file__).resolve().parents[1] / 'deploy' / 'deploy.sh').read_text(encoding='utf-8')
ARCHIVE_CODE = DEPLOY.split('verify_release() {', 1)[1].split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
LOADED_CODE = DEPLOY.split('verify_loaded_image() {', 1)[1].split("python3 -c '\n", 1)[1].split('\n\' "$VERIFIED_CONFIG_ID"', 1)[0]
ENGINE_ID = 'sha256:84b6c5f8c36b2a7730b70fbd7edb1a9301d8e7025614ede041384b80c8c883f3'
CLASSIC_ID = 'sha256:9a314ce6836f2ad96b22281a5da855c94d45da596a7edd4865c016dd74f04c7d'


def execute(code, arguments, input_value=None):
    previous_argv, previous_stdin = sys.argv, sys.stdin
    output = io.StringIO()
    try:
        sys.argv = ['validator'] + arguments
        if input_value is not None:
            sys.stdin = io.StringIO(json.dumps(input_value))
        with contextlib.redirect_stdout(output):
            exec(compile(code, '<deployment validator>', 'exec'), {})
        return output.getvalue().strip()
    finally:
        sys.argv, sys.stdin = previous_argv, previous_stdin


class DeploymentIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / '0.6.6-web.5'
        self.root.mkdir()
        self.image = 'zhihui-web:0.6.6-web.5'
        self.labels = {
            'org.opencontainers.image.revision': 'f' * 64,
            'org.opencontainers.image.version': self.root.name,
        }
        self.config = {'os': 'linux', 'architecture': 'amd64', 'config': {'Labels': self.labels}}
        self.write_archive()

    def write_manifest(self):
        (self.root / 'release-manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')

    def write_archive(self, config=None, config_name=None, tags=None, duplicate=False, symlink=False, duplicate_tag_entry=False, raw_config=None):
        raw = json.dumps(config or self.config).encode('utf-8') if raw_config is None else raw_config
        self.config_id = 'sha256:' + hashlib.sha256(raw).hexdigest()
        name = config_name or 'blobs/sha256/' + self.config_id.split(':')[1]
        entries = [{'Config': name, 'RepoTags': [self.image] if tags is None else tags, 'Layers': []}]
        if duplicate_tag_entry:
            entries.append(copy.deepcopy(entries[0]))
        with tarfile.open(str(self.root / 'image.tar'), 'w') as archive:
            manifest_data = json.dumps(entries).encode('utf-8')
            entry = tarfile.TarInfo('manifest.json')
            entry.size = len(manifest_data)
            archive.addfile(entry, io.BytesIO(manifest_data))
            entry = tarfile.TarInfo(name)
            entry.size = 0 if symlink else len(raw)
            if symlink:
                entry.type = tarfile.SYMTYPE
                entry.linkname = 'outside.json'
            archive.addfile(entry, None if symlink else io.BytesIO(raw))
            if duplicate:
                archive.addfile(entry, io.BytesIO(raw))
        self.manifest = {
            'productVersion': '0.6.6', 'webBuild': 5, 'releaseId': self.root.name,
            'image': self.image, 'imageId': ENGINE_ID, 'imageConfigId': self.config_id,
            'sourceSha256': 'f' * 64, 'databaseSchemaVersion': 1, 'imageArchive': 'image.tar',
            'desktop': {'sha256': 'd' * 64},
            'imageSha256': hashlib.sha256((self.root / 'image.tar').read_bytes()).hexdigest(),
        }
        self.write_manifest()
        (self.root / 'compose.yml').write_text('services: {}\n', encoding='utf-8')

    def verify_archive(self):
        return execute(ARCHIVE_CODE, [str(self.root)])

    def loaded(self, image_id):
        return {'Id': image_id, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Labels': self.labels}}

    def verify_loaded(self, image):
        return execute(LOADED_CODE, [CLASSIC_ID, ENGINE_ID, 'f' * 64, self.root.name], [image])

    def test_archive_returns_raw_config_digest(self):
        self.assertEqual(self.verify_archive(), self.config_id)

    def test_historical_manifest_can_derive_missing_config_digest(self):
        del self.manifest['imageConfigId']
        self.write_manifest()
        self.assertEqual(self.verify_archive(), self.config_id)

    def test_archive_hash_and_declared_config_digest_are_enforced(self):
        self.manifest['imageConfigId'] = 'sha256:' + '0' * 64
        self.write_manifest()
        with self.assertRaises(AssertionError):
            self.verify_archive()
        self.write_archive()
        with (self.root / 'image.tar').open('ab') as archive:
            archive.write(b'changed')
        with self.assertRaises(AssertionError):
            self.verify_archive()

    def test_unsafe_duplicate_and_nonregular_config_members_are_rejected(self):
        for options in ({'config_name': '../config.json'}, {'config_name': 'C:/config.json'}, {'config_name': 'config\n.json'}, {'duplicate': True}, {'symlink': True}):
            with self.subTest(options=options):
                self.write_archive(**options)
                with self.assertRaises(AssertionError):
                    self.verify_archive()

    def test_missing_and_ambiguous_expected_tags_are_rejected(self):
        for tags in (['another:image'], [self.image, self.image]):
            with self.subTest(tags=tags):
                self.write_archive(tags=tags)
                with self.assertRaises(AssertionError):
                    self.verify_archive()
        self.write_archive(duplicate_tag_entry=True)
        with self.assertRaises(AssertionError):
            self.verify_archive()

    def test_malformed_config_json_is_rejected(self):
        self.write_archive(raw_config=b'{invalid-json')
        with self.assertRaises(ValueError):
            self.verify_archive()

    def test_archived_platform_and_both_labels_are_enforced(self):
        for change in ('platform', 'revision', 'version'):
            config = copy.deepcopy(self.config)
            if change == 'platform':
                config['architecture'] = 'arm64'
            else:
                config['config']['Labels']['org.opencontainers.image.' + change] = 'wrong'
            with self.subTest(change=change):
                self.write_archive(config=config)
                with self.assertRaises(AssertionError):
                    self.verify_archive()

    def test_containerd_and_classic_ids_are_accepted_and_unknown_id_is_rejected(self):
        for image_id in (ENGINE_ID, CLASSIC_ID):
            self.verify_loaded(self.loaded(image_id))
        with self.assertRaises(AssertionError):
            self.verify_loaded(self.loaded('sha256:' + '0' * 64))

    def test_loaded_platform_and_both_labels_are_enforced_even_for_known_id(self):
        for change in ('platform', 'revision', 'version'):
            image = copy.deepcopy(self.loaded(CLASSIC_ID))
            if change == 'platform':
                image['Architecture'] = 'arm64'
            else:
                image['Config']['Labels']['org.opencontainers.image.' + change] = 'wrong'
            with self.subTest(change=change):
                with self.assertRaises(AssertionError):
                    self.verify_loaded(image)


if __name__ == '__main__':
    unittest.main()
