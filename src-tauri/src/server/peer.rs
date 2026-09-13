// peer — which process is on the other end of this connection?
//
// The approval prompt is the whole security value of pairing, and a prompt that
// says what the CALLER called itself is worth very little: any program on this
// machine can POST `{"app": "JHEditor"}` and the user sees a dialog naming an
// app they trust. The dialog has to name the program, not the claim.
//
// So: the client's ephemeral port comes from the accepted socket (axum's
// ConnectInfo), the TCP table maps that port to the PID that owns it, and the
// PID maps to a full executable path. All three are the operating system's
// answers, not the caller's.
//
// ── What this does NOT establish ──────────────────────────────────────────
// Authenticode. "C:\Program Files\JHEditor\jheditor.exe" is a path, and a path
// can be occupied by anything the user was willing to install there. Verifying
// the signature (WinVerifyTrust) and showing the publisher would close that,
// and is the obvious next step; it is deliberately not pretended to here, and
// `PeerInfo` has no `signed` field for a caller to misread as verified.
//
// ── Other platforms ───────────────────────────────────────────────────────
// The lookup is Windows-only for now (this is a Windows-first app). Elsewhere
// it returns None, and the prompt says the process could not be identified —
// which is the honest thing to show, and is different from showing a name the
// caller chose.

/// What the OS says about the process that opened this connection.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PeerInfo {
    pub pid: u32,
    /// Full path to the executable, when it could be read.
    pub exe: Option<String>,
}

/// Identify the process that connected from `peer_port` to our `local_port`.
///
/// Both ports are needed: an ephemeral port identifies a socket only together
/// with the other end, and matching on the client port alone would pick up an
/// unrelated connection that happens to have been assigned the same number.
#[cfg(windows)]
pub fn identify(peer_port: u16, local_port: u16) -> Option<PeerInfo> {
    let pid = owning_pid(peer_port, local_port)?;
    Some(PeerInfo { pid, exe: exe_path_of(pid) })
}

#[cfg(not(windows))]
pub fn identify(_peer_port: u16, _local_port: u16) -> Option<PeerInfo> {
    None
}

#[cfg(windows)]
fn owning_pid(peer_port: u16, local_port: u16) -> Option<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    unsafe {
        // Two calls: the first asks how big the table is, the second reads it.
        // The size can change between them (a connection opened or closed), so
        // a short retry loop rather than one attempt — ERROR_INSUFFICIENT_BUFFER
        // on the second call is normal, not a failure.
        let mut size: u32 = 0;
        let mut buf: Vec<u8> = Vec::new();
        for _ in 0..4 {
            let rc = GetExtendedTcpTable(
                if size == 0 { std::ptr::null_mut() } else { buf.as_mut_ptr() as *mut _ },
                &mut size,
                0, // not sorted: we scan the whole table anyway
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            const NO_ERROR: u32 = 0;
            const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
            if rc == NO_ERROR && size > 0 && !buf.is_empty() {
                break;
            }
            if rc == ERROR_INSUFFICIENT_BUFFER || (rc == NO_ERROR && buf.is_empty()) {
                buf = vec![0u8; size as usize];
                continue;
            }
            return None;
        }
        if buf.is_empty() {
            return None;
        }

        let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
        let rows = std::slice::from_raw_parts(
            table.table.as_ptr() as *const MIB_TCPROW_OWNER_PID,
            table.dwNumEntries as usize,
        );

        for row in rows {
            // The table stores ports in NETWORK byte order in the low 16 bits.
            // Reading them as-is gives 20480 for port 80, which matches nothing.
            if be_port(row.dwLocalPort) == peer_port && be_port(row.dwRemotePort) == local_port {
                return Some(row.dwOwningPid);
            }
        }
        None
    }
}

/// The low 16 bits of these fields are a big-endian port number.
#[cfg(windows)]
fn be_port(raw: u32) -> u16 {
    u16::from_be((raw & 0xFFFF) as u16)
}

/// The image path of a running process, or None if it is gone or unreadable.
/// Public because liveness (lib.rs `process_is_alive`) is the same question:
/// a path can only be read while the process exists.
#[cfg(windows)]
pub fn exe_path_of(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        // LIMITED_INFORMATION rather than QUERY_INFORMATION: reading the image
        // path is all this needs, and the narrower right is the one that also
        // works against a process running at a different integrity level.
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 32768];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 || len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::*;

    // The byte-order bug this function exists to avoid is silent: every lookup
    // simply fails to match, the prompt says "unidentified", and nothing in the
    // logs points at the cause.
    #[cfg(windows)]
    #[test]
    fn a_port_is_read_big_endian_from_the_low_half() {
        // 80 on the wire is 0x0050 big-endian, which a little-endian read of the
        // low 16 bits reports as 20480.
        assert_eq!(be_port(0x5000), 80);
        assert_eq!(be_port(0xBB01), 443);
        // The high half is other flags and must not reach the result.
        assert_eq!(be_port(0xFFFF_5000), 80);
        assert_eq!(be_port(0), 0);
    }

    // This process is certainly alive and certainly has a path, which is enough
    // to catch the handle/buffer plumbing being wrong.
    #[cfg(windows)]
    #[test]
    fn our_own_pid_resolves_to_our_own_exe() {
        let path = exe_path_of(std::process::id()).expect("our own image path should be readable");
        assert!(path.to_lowercase().ends_with(".exe"), "got {path}");
        // No embedded NULs: the length from QueryFullProcessImageNameW is in
        // characters and excludes the terminator, so a fencepost error here
        // shows up as a trailing \0.
        assert!(!path.contains('\0'), "path must be trimmed to its real length");
    }

    #[cfg(windows)]
    #[test]
    fn an_impossible_pid_resolves_to_nothing() {
        // PID 0 is the System Idle Process; it cannot be opened for querying.
        assert!(exe_path_of(0).is_none());
    }

    #[cfg(not(windows))]
    #[test]
    fn identification_is_absent_rather_than_guessed() {
        assert!(super::identify(1234, 14300).is_none());
    }
}
