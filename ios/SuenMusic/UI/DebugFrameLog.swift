import SwiftUI

#if DEBUG
extension View {
    /// **DEBUG 临时**：把全局 frame 打到系统日志（SUEN_DEBUG_LAYOUT=1 才打印）
    func frameLog(_ name: String) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { r in
            guard DebugHooks.string("SUEN_DEBUG_LAYOUT") == "1" else { return }
            NSLog("[Layout] \(name) x=\(Int(r.minX)) y=\(Int(r.minY)) w=\(Int(r.width)) h=\(Int(r.height)) maxX=\(Int(r.maxX)) maxY=\(Int(r.maxY))")
        }
    }
}
#endif
