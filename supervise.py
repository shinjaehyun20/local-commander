"""Windows child process owner. Job closes on supervisor exit, killing descendants."""
import base64, ctypes, json, os, subprocess, sys
from ctypes import wintypes

def main():
    spec = json.loads(base64.b64decode(sys.argv[1]))
    if os.name != 'nt':
        raise RuntimeError('Windows supervisor only')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    class Basic(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit',ctypes.c_longlong),('PerJobUserTimeLimit',ctypes.c_longlong),('LimitFlags',wintypes.DWORD),('MinimumWorkingSetSize',ctypes.c_size_t),('MaximumWorkingSetSize',ctypes.c_size_t),('ActiveProcessLimit',wintypes.DWORD),('Affinity',ctypes.c_size_t),('PriorityClass',wintypes.DWORD),('SchedulingClass',wintypes.DWORD)]
    class Io(ctypes.Structure):
        _fields_ = [(name,ctypes.c_ulonglong) for name in ['ReadOperationCount','WriteOperationCount','OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount']]
    class Extended(ctypes.Structure):
        _fields_ = [('BasicLimitInformation',Basic),('IoInfo',Io),('ProcessMemoryLimit',ctypes.c_size_t),('JobMemoryLimit',ctypes.c_size_t),('PeakProcessMemoryUsed',ctypes.c_size_t),('PeakJobMemoryUsed',ctypes.c_size_t)]
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p,wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE,wintypes.HANDLE]
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE,wintypes.UINT]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None,None)
    if not job: raise ctypes.WinError(ctypes.get_last_error())
    info = Extended(); info.BasicLimitInformation.LimitFlags = 0x2000
    child = None
    try:
        if not kernel.SetInformationJobObject(job,9,ctypes.byref(info),ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        child = subprocess.Popen([spec['executable'],*spec['args']],cwd=spec['cwd'],creationflags=0x4|0x08000000,stdin=sys.stdin,stdout=sys.stdout,stderr=sys.stderr)
        if not kernel.AssignProcessToJobObject(job,wintypes.HANDLE(int(child._handle))):
            raise ctypes.WinError(ctypes.get_last_error())
        nt = ctypes.WinDLL('ntdll'); nt.NtResumeProcess.argtypes=[wintypes.HANDLE]; nt.NtResumeProcess.restype=ctypes.c_long
        if nt.NtResumeProcess(wintypes.HANDLE(int(child._handle))) != 0:
            raise RuntimeError('Unable to resume owned child')
        return child.wait()
    finally:
        if child is not None and child.poll() is None:
            kernel.TerminateProcess(wintypes.HANDLE(int(child._handle)),1)
        kernel.CloseHandle(job)

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as exc:
        print(str(exc),file=sys.stderr); sys.exit(1)
