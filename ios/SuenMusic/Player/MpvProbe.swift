import Foundation

// libmpv 的 C 模块由 MPVKit 包里的 Libmpv.xcframework 提供（MPVKit 官方 Demo 也是 import Libmpv）。
// 这里刻意调用真实符号而不是空 import：没链接上 libmpv 就编译/链接不过。
import Libmpv

/// P0 探针：只用来验证 MPVKit（libmpv + ffmpeg）已正确链接进 App。
/// P1 的 MPVPlayer 落地后会把它替换成真正的播放实现。
enum MpvProbe {
    /// libmpv 的 client API 版本，编码为 (major << 16) | minor。
    /// 返回值由链接进来的 libmpv 决定，符号缺失时编译必失败。
    static func clientAPIVersion() -> UInt {
        mpv_client_api_version()
    }

    /// "libmpv 2.3" 这样的人类可读版本串。
    static func apiVersionString() -> String {
        let v = clientAPIVersion()
        return "libmpv \(v >> 16).\(v & 0xFFFF)"
    }

    /// 建一次 mpv 句柄再销毁：证明 libmpv 运行时真的可用（不止能编译）。
    static func canCreateHandle() -> Bool {
        guard let handle = mpv_create() else { return false }
        mpv_terminate_destroy(handle)
        return true
    }
}
