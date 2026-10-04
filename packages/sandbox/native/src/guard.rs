use crate::protocol::NATIVE_BYTES;

#[cfg(windows)]
pub struct Guard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for Guard {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); }
    }
}

#[cfg(windows)]
impl Guard {
    pub fn establish() -> Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::GetLastError,
            System::{
                JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_PROCESS_MEMORY, QueryInformationJobObject, SetInformationJobObject},
                Memory::{MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE, VirtualAlloc, VirtualFree},
                Threading::GetCurrentProcess,
            },
        };
        unsafe {
            let job = CreateJobObjectW(core::ptr::null(), core::ptr::null());
            if job.is_null() { return Err(format!("Windows Job Object creation failed ({})", GetLastError())); }
            let guard = Self(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = core::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            limits.ProcessMemoryLimit = NATIVE_BYTES;
            let size = core::mem::size_of_val(&limits) as u32;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as _, size) == 0
                || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                return Err(format!("Windows committed-process limit prerequisite failed ({})", GetLastError()));
            }
            let mut effective: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = core::mem::zeroed();
            if QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &mut effective as *mut _ as _, size, core::ptr::null_mut()) == 0
                || effective.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_PROCESS_MEMORY == 0
                || effective.ProcessMemoryLimit != NATIVE_BYTES {
                return Err("Windows committed-process limit readback failed".into());
            }
            let control = VirtualAlloc(core::ptr::null(), 65536, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
            if control.is_null() { return Err("Windows memory enforcement control allocation failed".into()); }
            VirtualFree(control, 0, MEM_RELEASE);
            let excess = VirtualAlloc(core::ptr::null(), NATIVE_BYTES + 65536, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
            if !excess.is_null() {
                VirtualFree(excess, 0, MEM_RELEASE);
                return Err("Windows committed-process memory limit is not enforcing".into());
            }
            // A failed over-budget allocation is only evidence together with the
            // actual current-process job membership and effective limit readback.
            let error = GetLastError();
            if error != 8 && error != 1455 && error != 1816 {
                return Err(format!("Windows memory enforcement probe failed unexpectedly ({error})"));
            }
            Ok(guard)
        }
    }

    pub fn kind(&self) -> &'static str { "windows-job-committed" }
}

#[cfg(unix)]
pub struct Guard;

#[cfg(target_os = "linux")]
fn startup_virtual_size() -> Result<u64, String> {
    let statm = std::fs::read_to_string("/proc/self/statm").map_err(|_| "Linux /proc/self/statm is required for native containment")?;
    let pages = statm.split_ascii_whitespace().next().ok_or("Invalid Linux virtual size")?.parse::<u64>().map_err(|_| "Invalid Linux virtual size")?;
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 { return Err("Cannot determine Linux page size".into()); }
    pages.checked_mul(page_size as u64).ok_or_else(|| "Linux startup virtual size overflow".into())
}

#[cfg(target_os = "macos")]
fn startup_virtual_size() -> Result<u64, String> {
    #[repr(C)]
    struct TimeValue { seconds: i32, microseconds: i32 }
    #[repr(C)]
    struct MachTaskBasicInfo {
        virtual_size: u64, resident_size: u64, resident_size_max: u64,
        user_time: TimeValue, system_time: TimeValue, policy: i32, suspend_count: i32,
    }
    unsafe extern "C" {
        static mach_task_self_: u32;
        fn task_info(task: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
    }
    let mut release = [0u8; 128];
    let mut release_length = release.len();
    if unsafe { libc::sysctlbyname(c"kern.osrelease".as_ptr(), release.as_mut_ptr().cast(), &mut release_length, core::ptr::null_mut(), 0) } != 0
        || release_length == 0 || release_length > release.len() {
        return Err("Cannot establish the macOS 26+ native host prerequisite".into());
    }
    let kernel_major = core::str::from_utf8(&release[..release_length]).ok()
        .and_then(|v| v.split('.').next()).and_then(|v| v.parse::<u32>().ok());
    if !kernel_major.is_some_and(|major| major >= 25) {
        return Err("Native component memory containment requires macOS 26+; ordinary CLI remains available".into());
    }
    let mut info: MachTaskBasicInfo = unsafe { core::mem::zeroed() };
    let mut count = (core::mem::size_of_val(&info) / core::mem::size_of::<i32>()) as u32;
    let result = unsafe { task_info(mach_task_self_, 20, &mut info as *mut _ as *mut i32, &mut count) };
    if result != 0 || count as usize != core::mem::size_of_val(&info) / core::mem::size_of::<i32>() {
        return Err(format!("Darwin startup address-space observation failed ({result})"));
    }
    Ok(info.virtual_size)
}

#[cfg(unix)]
impl Guard {
    pub fn establish() -> Result<Self, String> {
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        return Err("Unsupported Unix memory-containment target".into());
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        unsafe {
            let startup = startup_virtual_size()?;
            let ceiling = startup.checked_add(NATIVE_BYTES as u64).ok_or("Native address-space budget overflow")?;
            let mut previous: libc::rlimit = core::mem::zeroed();
            if libc::getrlimit(libc::RLIMIT_AS, &mut previous) != 0 { return Err("Cannot read RLIMIT_AS".into()); }
            if previous.rlim_max != libc::RLIM_INFINITY && previous.rlim_max < ceiling as libc::rlim_t {
                return Err("Existing hard RLIMIT_AS is below startup virtual size plus 2 GiB".into());
            }
            let limit = libc::rlimit { rlim_cur: ceiling as libc::rlim_t, rlim_max: ceiling as libc::rlim_t };
            if libc::setrlimit(libc::RLIMIT_AS, &limit) != 0 { return Err(format!("Hard RLIMIT_AS prerequisite failed: {}", std::io::Error::last_os_error())); }
            let mut effective: libc::rlimit = core::mem::zeroed();
            if libc::getrlimit(libc::RLIMIT_AS, &mut effective) != 0 || effective.rlim_cur != limit.rlim_cur || effective.rlim_max != limit.rlim_max {
                return Err("Hard RLIMIT_AS readback failed".into());
            }
            let control = libc::mmap(core::ptr::null_mut(), 65536, libc::PROT_NONE, libc::MAP_PRIVATE | libc::MAP_ANON, -1, 0);
            if control == libc::MAP_FAILED { return Err("Address-space probe control mapping failed".into()); }
            libc::munmap(control, 65536);
            let probe_bytes = usize::try_from(ceiling).map_err(|_| "Address-space probe size overflow")?.checked_add(65536).ok_or("Address-space probe size overflow")?;
            let excess = libc::mmap(core::ptr::null_mut(), probe_bytes, libc::PROT_NONE, libc::MAP_PRIVATE | libc::MAP_ANON, -1, 0);
            if excess != libc::MAP_FAILED {
                libc::munmap(excess, probe_bytes);
                return Err("Hard RLIMIT_AS is not enforcing; native component execution refused".into());
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOMEM) {
                return Err("Address-space enforcement probe failed for a non-budget reason".into());
            }
            Ok(Self)
        }
    }

    pub fn kind(&self) -> &'static str { "unix-address-space" }
}

#[cfg(not(any(windows, unix)))]
compile_error!("Native component host requires a supported Windows or Unix memory boundary");
