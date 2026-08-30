// install — is this copy the INSTALLED one, or a portable one?
//
// The updater downloads an NSIS installer and runs it with /UPDATE and no /D, so it
// always writes to the registered install directory. Unzip the portable build
// somewhere, take an update, and the new version lands in the install location while
// the copy being run stays exactly as it was. Nothing errors, nothing is reported,
// and the next launch is still the old build — the worst shape a failure can take,
// because the user believes they updated.
//
// So the app has to be able to tell. The installer writes its own location to the
// registry (src-tauri/nsis/hooks.nsh); comparing that against the directory this exe
// is running from answers the question. A portable copy either finds no value at all
// or finds one pointing somewhere else.

/// Where the installer recorded itself, or None.
///
/// Both hives are read: `installMode: "both"` means the install could be per-user
/// (HKCU) or per-machine (HKLM), and a portable copy must be recognised as portable
/// regardless of which one an installed copy on the same machine used.
#[cfg(windows)]
fn recorded_install_dir() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    for hive in ["HKCU", "HKLM"] {
        let key = format!(r"{}\Software\{}", hive, super::shell::NOTIFY_APP_ID);
        let out = Command::new("reg")
            .args(["query", &key, "/v", "InstallLocation"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let Ok(out) = out else { continue };
        if !out.status.success() {
            continue;
        }
        // `reg query` prints:  InstallLocation    REG_SZ    C:\path\with spaces
        // Splitting on REG_SZ keeps paths containing spaces intact, which
        // splitting on whitespace would not.
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(value) = text.split("REG_SZ").nth(1) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Compare two directory paths the way Windows does.
///
/// Case-insensitive, and trailing separators ignored: the registry value and
/// `current_exe()` are both legitimate spellings of the same directory and need not
/// match byte for byte.
pub fn same_dir(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim()
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_lowercase()
    };
    !a.trim().is_empty() && norm(a) == norm(b)
}

/// Is the running executable the copy the installer put down?
///
/// `false` means portable — which is not an error and not a lesser mode. It only
/// means updates cannot be applied to this copy, so it must not be offered any.
#[tauri::command]
pub fn is_installed() -> bool {
    #[cfg(windows)]
    {
        let Some(recorded) = recorded_install_dir() else {
            return false;
        };
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let Some(dir) = exe.parent() else { return false };
        same_dir(&recorded, &dir.to_string_lossy())
    }
    // No portable distribution exists for other platforms yet, so nothing is gained
    // by declaring a copy portable there — it would only suppress updates.
    #[cfg(not(windows))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::same_dir;

    #[test]
    fn matches_the_same_directory_spelled_differently() {
        assert!(same_dir(r"C:\Program Files\J.H AI Agent", r"c:\program files\j.h ai agent"));
        assert!(same_dir(r"C:\Apps\JHAI\", r"C:\Apps\JHAI"));
        assert!(same_dir("C:/Apps/JHAI", r"C:\Apps\JHAI"));
    }

    #[test]
    fn a_copy_somewhere_else_is_not_the_install() {
        assert!(!same_dir(r"C:\Program Files\J.H AI Agent", r"D:\portable\jhai"));
    }

    /// An empty registry value must not read as "matches an empty path".
    #[test]
    fn an_empty_recorded_path_never_matches() {
        assert!(!same_dir("", ""));
        assert!(!same_dir("   ", r"C:\anywhere"));
    }
}
