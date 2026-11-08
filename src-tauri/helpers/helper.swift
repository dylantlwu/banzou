// 伴奏歌词的系统能力小助手（Swift），作为 Tauri sidecar 打进 app。
//
// banzou-helper transcribe <音频文件> [语言，默认 zh_CN]
//   识别人声分轨里唱的字和每个字的时间，供「智能对齐」使用。
//   用 macOS 自带的离线语音识别（SpeechAnalyzer / SpeechTranscriber），不联网、不需要下载。
//   输出：每行一个 JSON：{"start":秒,"end":秒,"text":"字"}
//
// banzou-helper route
//   当前音频输出 / 输入设备：名字、连接方式（内置扬声器 / 有线耳机 / 蓝牙 / USB …），供录音前的耳机检测使用。
//   输出：一行 JSON
//
// 出错时输出 {"error":"..."} 并以 1 退出。

import AVFoundation
import CoreAudio
import Foundation
import Speech

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

func fail(_ message: String) -> Never {
    emit(["error": message])
    exit(1)
}

// ---------- route ----------

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
    var id = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var addr = address(selector)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return status == noErr && id != 0 ? id : nil
}

func uint32Property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope) -> UInt32? {
    var value = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var addr = address(selector, scope)
    guard AudioObjectHasProperty(id, &addr) else { return nil }
    return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func deviceName(_ id: AudioObjectID) -> String {
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var addr = address(kAudioObjectPropertyName)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name) == noErr, let n = name else { return "" }
    return n.takeRetainedValue() as String
}

func fourCC(_ s: String) -> UInt32 {
    s.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
}

/// speaker（内置扬声器）/ wired（有线耳机）/ bluetooth / usb / airplay / hdmi / other
func describe(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> [String: Any] {
    let transport = uint32Property(id, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal) ?? 0
    let source = uint32Property(id, kAudioDevicePropertyDataSource, scope)
    var kind = "other"
    switch transport {
    case kAudioDeviceTransportTypeBuiltIn:
        if scope == kAudioObjectPropertyScopeOutput {
            kind = source == fourCC("hdpn") ? "wired" : "speaker"
        } else {
            kind = source == fourCC("emic") ? "wired" : "builtin"
        }
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: kind = "bluetooth"
    case kAudioDeviceTransportTypeUSB: kind = "usb"
    case kAudioDeviceTransportTypeAirPlay: kind = "airplay"
    case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: kind = "hdmi"
    default: kind = "other"
    }
    return ["name": deviceName(id), "kind": kind]
}

func route() -> Never {
    var out: [String: Any] = [:]
    if let o = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) { out["output"] = describe(o, scope: kAudioObjectPropertyScopeOutput) }
    if let i = defaultDevice(kAudioHardwarePropertyDefaultInputDevice) { out["input"] = describe(i, scope: kAudioObjectPropertyScopeInput) }
    emit(out)
    exit(0)
}

// ---------- transcribe ----------

let args = CommandLine.arguments
guard args.count >= 2 else { fail("用法：banzou-helper transcribe <音频文件> [语言] | route") }
if args[1] == "route" { route() }
guard args[1] == "transcribe", args.count >= 3 else { fail("用法：banzou-helper transcribe <音频文件> [语言] | route") }
let url = URL(fileURLWithPath: args[2])
let locale = Locale(identifier: args.count >= 4 ? args[3] : "zh_CN")

let done = DispatchSemaphore(value: 0)
Task {
    defer { done.signal() }
    do {
        let installed = await SpeechTranscriber.installedLocales
        guard installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
            fail("系统里没有「\(locale.identifier)」的离线语音识别模型")
        }
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: [.audioTimeRange]
        )
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let file = try AVAudioFile(forReading: url)
        let collector = Task {
            for try await result in transcriber.results {
                for run in result.text.runs {
                    guard let range = run.audioTimeRange else { continue }
                    let text = String(result.text[run.range].characters)
                    emit(["start": range.start.seconds, "end": range.end.seconds, "text": text])
                }
            }
        }
        try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
        try await collector.value
    } catch {
        fail("语音识别失败：\(error.localizedDescription)")
    }
}
done.wait()
