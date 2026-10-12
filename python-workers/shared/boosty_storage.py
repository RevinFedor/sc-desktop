"""Physical storage proof for disposable Boosty media; never a directory-name test."""
import os
import plistlib
import shutil
import subprocess
from pathlib import Path


class StorageError(RuntimeError):
    pass


def real_future_path(value):
    path = Path(value).expanduser().absolute()
    tail = []
    while not path.exists():
        if path == path.parent:
            raise StorageError("Не удалось проверить родительскую папку")
        tail.append(path.name)
        path = path.parent
    result = path.resolve(strict=True)
    for part in reversed(tail):
        result = result / part
    return result


def volume_info(path):
    # diskutil accepts a volume/device, not an arbitrary directory. df asks
    # the kernel for the actual containing filesystem, including symlinks.
    frame = subprocess.run(["/bin/df", "-P", str(path)], capture_output=True, check=False, timeout=15)
    rows = frame.stdout.decode(errors="replace").splitlines()
    if frame.returncode or len(rows) < 2:
        raise StorageError("Не удалось определить файловую систему")
    device = rows[-1].split()[0]
    if not device.startswith("/dev/disk"):
        raise StorageError("Путь не находится на локальном физическом диске")
    result = subprocess.run(["/usr/sbin/diskutil", "info", "-plist", device],
                            capture_output=True, check=False, timeout=15)
    if result.returncode:
        raise StorageError("Не удалось проверить физический диск")
    raw = plistlib.loads(result.stdout)
    return {k: raw.get(k) for k in ("MountPoint", "DeviceIdentifier", "VolumeUUID", "Internal",
                                   "BusProtocol", "WritableVolume", "ReadOnlyVolume")}


def inspect_storage(config, *, external_mount="/Volumes/digma512", reserve_bytes=5 * 1024 ** 3,
                    expected_volume_uuid=None, disk_info=volume_info, stat=os.stat, usage=shutil.disk_usage):
    mount = Path(external_mount).resolve(strict=True)
    info = disk_info(mount)
    if info.get("MountPoint") != str(mount) or info.get("Internal") is not False or info.get("BusProtocol") != "USB":
        raise StorageError("Нужен настоящий смонтированный внешний USB-диск, не похожая папка")
    if info.get("WritableVolume") is not True or info.get("ReadOnlyVolume") is True:
        raise StorageError("Внешний диск недоступен для записи")
    if expected_volume_uuid and info.get("VolumeUUID") != expected_volume_uuid:
        raise StorageError("После preflight подключён другой диск")
    mount_device = stat(mount).st_dev
    roots = {k: real_future_path(config[k]) for k in ("audio_dir", "work_dir", "transcript_dir", "library_root")}
    for key in ("audio_dir", "work_dir"):
        if not roots[key].is_relative_to(mount):
            raise StorageError(f"{key}: временное медиа должно быть только на внешнем USB")
        probe = roots[key]
        while not probe.exists():
            probe = probe.parent
        if stat(probe).st_dev != mount_device:
            raise StorageError("Медиа-путь ведёт на другую файловую систему")
    for key in ("transcript_dir", "library_root"):
        probe = roots[key]
        while not probe.exists():
            probe = probe.parent
        local = disk_info(probe)
        if local.get("Internal") is not True or stat(probe).st_dev == mount_device:
            raise StorageError("Тексты и индекс должны физически оставаться на Mac")
    free = usage(mount).free
    if free < reserve_bytes:
        raise StorageError("На USB недостаточно свободного места с учётом резерва")
    return {"ok": True, "external_mount": str(mount), "volume_uuid": info.get("VolumeUUID"),
            "device": info.get("DeviceIdentifier"), "st_dev": mount_device, "free_bytes": free,
            "reserve_bytes": reserve_bytes, "roots": {k: str(v) for k, v in roots.items()}}


def describe_config(config):
    """Read-only current roots, including an honest strict-readiness error."""
    result = {"configured": {k: str(v) for k, v in config.items() if k.endswith("dir")},
              "library_root": str(config["library_root"])}
    result["physical_roots"] = {}
    for key in ("audio_dir", "work_dir", "transcript_dir", "library_root"):
        try:
            real = real_future_path(config[key])
            probe = real
            while not probe.exists():
                probe = probe.parent
            result["physical_roots"][key] = {"real_path": str(real), "volume": volume_info(probe)}
        except Exception:
            result["physical_roots"][key] = {"error": "Не удалось проверить физический путь"}
    try:
        result["strict_external_ready"] = inspect_storage(config)
    except Exception as exc:
        result["strict_external_ready"] = {"ok": False, "error": str(exc) if isinstance(exc, StorageError) else "Не удалось проверить физические пути"}
    return result
