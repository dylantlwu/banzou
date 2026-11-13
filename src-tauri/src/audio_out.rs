//! 出声设备（macOS CoreAudio）：列出能出声的设备、读系统默认输出、监听变化。只读，不改系统设置。
//!
//! 波点的声音全走 WKWebView 里的 Web Audio，只能跟着系统默认输出走（WKWebView 的 AudioContext
//! 没有 setSinkId）。用户在系统设置 / 控制中心里切设备时，这里发事件给前端，播放器确认声音跟过去了。
//! 直接用 CoreAudio 的 C 接口，不额外加依赖。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    /// 系统给的稳定标识
    pub uid: String,
    pub name: String,
    /// speaker / wired / bluetooth / usb / airplay / hdmi / virtual / other
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputsSnapshot {
    pub devices: Vec<OutputDevice>,
    /// 当前系统默认输出的 uid；读不到时为 None
    pub default_uid: Option<String>,
}

pub const fn fourcc(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
}

/// 按 CoreAudio 的连接方式（transport type）和数据源判断设备类型
pub fn kind_of(transport: u32, data_source: Option<u32>) -> &'static str {
    match transport {
        t if t == fourcc(b"bltn") => {
            if data_source == Some(fourcc(b"hdpn")) {
                "wired"
            } else {
                "speaker"
            }
        }
        t if t == fourcc(b"blue") || t == fourcc(b"blea") => "bluetooth",
        t if t == fourcc(b"usb ") => "usb",
        t if t == fourcc(b"airp") => "airplay",
        t if t == fourcc(b"hdmi") || t == fourcc(b"dprt") => "hdmi",
        t if t == fourcc(b"virt") || t == fourcc(b"grup") || t == fourcc(b"aggr") => "virtual",
        _ => "other",
    }
}

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::{c_char, c_void};

    pub type OSStatus = i32;
    pub type AudioObjectID = u32;

    #[repr(C)]
    pub struct Address {
        pub selector: u32,
        pub scope: u32,
        pub element: u32,
    }

    pub type Listener = unsafe extern "C" fn(AudioObjectID, u32, *const Address, *mut c_void) -> OSStatus;

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        pub fn AudioObjectHasProperty(id: AudioObjectID, addr: *const Address) -> u8;
        pub fn AudioObjectGetPropertyDataSize(id: AudioObjectID, addr: *const Address, qsize: u32, qdata: *const c_void, size: *mut u32) -> OSStatus;
        pub fn AudioObjectGetPropertyData(id: AudioObjectID, addr: *const Address, qsize: u32, qdata: *const c_void, size: *mut u32, data: *mut c_void) -> OSStatus;
        pub fn AudioObjectAddPropertyListener(id: AudioObjectID, addr: *const Address, listener: Listener, client: *mut c_void) -> OSStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        pub fn CFStringGetLength(s: *const c_void) -> isize;
        pub fn CFStringGetMaximumSizeForEncoding(len: isize, encoding: u32) -> isize;
        pub fn CFStringGetCString(s: *const c_void, buf: *mut c_char, size: isize, encoding: u32) -> u8;
        pub fn CFRelease(p: *const c_void);
    }

    pub const UTF8: u32 = 0x0800_0100;
}

#[cfg(target_os = "macos")]
mod mac {
    use super::ffi::*;
    use super::{fourcc, kind_of, OutputDevice, OutputsSnapshot};
    use std::ffi::{c_void, CStr};
    use std::sync::OnceLock;

    const SYSTEM: AudioObjectID = 1;
    const GLOBAL: u32 = fourcc(b"glob");
    const OUTPUT: u32 = fourcc(b"outp");

    fn addr(selector: &[u8; 4], scope: u32) -> Address {
        Address { selector: fourcc(selector), scope, element: 0 }
    }

    fn u32_prop(id: AudioObjectID, selector: &[u8; 4], scope: u32) -> Option<u32> {
        let a = addr(selector, scope);
        let mut v: u32 = 0;
        let mut size = 4u32;
        unsafe {
            if AudioObjectHasProperty(id, &a) == 0 {
                return None;
            }
            (AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, (&mut v as *mut u32).cast()) == 0).then_some(v)
        }
    }

    fn string_prop(id: AudioObjectID, selector: &[u8; 4]) -> Option<String> {
        let a = addr(selector, GLOBAL);
        let mut s: *const c_void = std::ptr::null();
        let mut size = std::mem::size_of::<*const c_void>() as u32;
        unsafe {
            if AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, (&mut s as *mut *const c_void).cast()) != 0 || s.is_null() {
                return None;
            }
            let cap = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), UTF8) + 1;
            let mut buf = vec![0 as std::ffi::c_char; cap.max(1) as usize];
            let ok = CFStringGetCString(s, buf.as_mut_ptr(), cap, UTF8) != 0;
            CFRelease(s);
            ok.then(|| CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
        }
    }

    fn stream_count(id: AudioObjectID, scope: u32) -> u32 {
        let a = addr(b"stm#", scope);
        let mut size = 0u32;
        unsafe {
            if AudioObjectGetPropertyDataSize(id, &a, 0, std::ptr::null(), &mut size) != 0 {
                return 0;
            }
        }
        size / 4
    }

    fn device_ids() -> Vec<AudioObjectID> {
        let a = addr(b"dev#", GLOBAL);
        let mut size = 0u32;
        unsafe {
            if AudioObjectGetPropertyDataSize(SYSTEM, &a, 0, std::ptr::null(), &mut size) != 0 {
                return vec![];
            }
            let mut ids = vec![0u32; size as usize / 4];
            if AudioObjectGetPropertyData(SYSTEM, &a, 0, std::ptr::null(), &mut size, ids.as_mut_ptr().cast()) != 0 {
                return vec![];
            }
            ids.truncate(size as usize / 4);
            ids
        }
    }

    fn describe(id: AudioObjectID) -> Option<OutputDevice> {
        if stream_count(id, OUTPUT) == 0 {
            return None;
        }
        // 不能当默认输出的（比如部分聚合设备的子设备）不列出来
        if u32_prop(id, b"dflt", OUTPUT) == Some(0) {
            return None;
        }
        let uid = string_prop(id, b"uid ")?;
        let name = string_prop(id, b"lnam").unwrap_or_else(|| uid.clone());
        let transport = u32_prop(id, b"tran", GLOBAL).unwrap_or(0);
        let source = u32_prop(id, b"ssrc", OUTPUT);
        Some(OutputDevice { uid, name, kind: kind_of(transport, source).into() })
    }

    pub fn snapshot() -> OutputsSnapshot {
        let def = u32_prop(SYSTEM, b"dOut", GLOBAL).filter(|&id| id != 0);
        let mut default_uid = None;
        let mut devices = vec![];
        for id in device_ids() {
            if let Some(d) = describe(id) {
                if Some(id) == def {
                    default_uid = Some(d.uid.clone());
                }
                devices.push(d);
            }
        }
        OutputsSnapshot { devices, default_uid }
    }

    static ON_CHANGE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

    unsafe extern "C" fn listener(_: AudioObjectID, _: u32, _: *const Address, _: *mut c_void) -> OSStatus {
        if let Some(f) = ON_CHANGE.get() {
            f();
        }
        0
    }

    /// 默认输出变了、设备插拔了都会回调（在 CoreAudio 的线程上）。只能注册一次。
    pub fn watch(f: Box<dyn Fn() + Send + Sync>) -> Result<(), String> {
        ON_CHANGE.set(f).map_err(|_| "已经在监听出声设备了".to_string())?;
        for sel in [b"dOut", b"dev#"] {
            let a = addr(sel, GLOBAL);
            let status = unsafe { AudioObjectAddPropertyListener(SYSTEM, &a, listener, std::ptr::null_mut()) };
            if status != 0 {
                return Err(format!("监听出声设备失败（{status}）"));
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use mac::{snapshot, watch};

#[cfg(not(target_os = "macos"))]
pub fn snapshot() -> OutputsSnapshot {
    OutputsSnapshot { devices: vec![], default_uid: None }
}
#[cfg(not(target_os = "macos"))]
pub fn watch(_f: Box<dyn Fn() + Send + Sync>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fourcc_matches_coreaudio_constants() {
        // kAudioHardwarePropertyDefaultOutputDevice = 'dOut' = 0x644F7574
        assert_eq!(fourcc(b"dOut"), 0x644F_7574);
        assert_eq!(fourcc(b"glob"), 0x676C_6F62);
    }

    #[test]
    fn classifies_devices() {
        assert_eq!(kind_of(fourcc(b"bltn"), Some(fourcc(b"ispk"))), "speaker");
        assert_eq!(kind_of(fourcc(b"bltn"), Some(fourcc(b"hdpn"))), "wired");
        assert_eq!(kind_of(fourcc(b"bltn"), None), "speaker");
        assert_eq!(kind_of(fourcc(b"usb "), None), "usb");
        assert_eq!(kind_of(fourcc(b"blue"), None), "bluetooth");
        assert_eq!(kind_of(fourcc(b"blea"), None), "bluetooth");
        assert_eq!(kind_of(fourcc(b"dprt"), None), "hdmi");
        assert_eq!(kind_of(fourcc(b"airp"), None), "airplay");
        assert_eq!(kind_of(0, None), "other");
    }

    #[test]
    fn snapshot_is_consistent() {
        // 只读：列出本机设备，默认设备（如果有）一定在列表里
        let s = snapshot();
        if let Some(uid) = &s.default_uid {
            assert!(s.devices.iter().any(|d| &d.uid == uid));
        }
        let mut uids: Vec<_> = s.devices.iter().map(|d| d.uid.clone()).collect();
        uids.dedup();
        assert_eq!(uids.len(), s.devices.len());
    }
}
