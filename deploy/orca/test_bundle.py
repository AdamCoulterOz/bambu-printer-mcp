import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
class BundleTests(unittest.TestCase):
    def test_complete_manifest_and_unmanifested_file(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'bundle';root.mkdir(); f=root/'ORCA_COMMIT';f.write_text('dummy\n')
            (root/'SHA256SUMS').write_text(hashlib.sha256(f.read_bytes()).hexdigest()+'  ORCA_COMMIT\n')
            source=Path(__file__).with_name('verify_bundle.py').read_text().replace("Path('/bundle')",f'Path({str(root)!r})')
            program=Path(d)/'check.py';program.write_text(source)
            self.assertEqual(subprocess.run([sys.executable,str(program)],capture_output=True).returncode,0)
            (root/'unmanifested').write_text('x')
            self.assertNotEqual(subprocess.run([sys.executable,str(program)],capture_output=True).returncode,0)
if __name__=='__main__': unittest.main()
