"""Byte-driven download backpressure with physical-volume proof, no eviction."""
import os
import shutil
from pathlib import Path
from shared.boosty_storage import inspect_storage, StorageError


class BudgetPause(StorageError):
    pass


def owned_bytes(root, device):
    total = 0
    if not Path(root).exists(): return 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            p = Path(directory) / name
            st = p.lstat()
            if p.is_symlink() or st.st_dev != device:
                raise BudgetPause('Owned namespace changed filesystem or contains a symlink')
            if p.is_file(): total += max(st.st_size, getattr(st, 'st_blocks', 0) * 512)
    return total


class DownloadBudget:
    def __init__(self, config, owned_root, ceiling_bytes, proof=None):
        self.config = config; self.root = Path(owned_root); self.ceiling = ceiling_bytes
        self.proof = proof or inspect_storage(config, external_mount=config['external_mount'],
            expected_volume_uuid=config.get('volume_uuid'), reserve_bytes=config['reserve_bytes'])
        self.device = self.proof['st_dev']; self.peak_bytes = 0

    def check(self, extra_bytes=0, physical=False):
        if physical:
            self.proof = inspect_storage(self.config, external_mount=self.config['external_mount'],
                expected_volume_uuid=self.config['volume_uuid'], reserve_bytes=self.config['reserve_bytes'])
        if self.root.exists() and self.root.stat().st_dev != self.device:
            raise BudgetPause('External namespace is no longer on admitted USB')
        actual = owned_bytes(self.root, self.device)
        self.peak_bytes = max(self.peak_bytes, actual)
        free = shutil.disk_usage(self.config['external_mount']).free
        if actual + extra_bytes > self.ceiling or free - extra_bytes < self.config['reserve_bytes']:
            raise BudgetPause('Owned media+scratch ceiling/free reserve reached; retain partial files')
        return {'owned_bytes': actual, 'peak_bytes': self.peak_bytes, 'free_bytes': free, 'ceiling_bytes': self.ceiling}
