import SwiftUI
import AppKit
import AVKit
import AVFoundation
import CryptoKit
import Combine

struct ExamRecord: Identifiable, Hashable {
    let id = UUID()
    let folderURL: URL
    let patientID: String
    let firstName: String
    let lastName: String
    let examDate: String
    let birthDate: String
    let sex: String
    let numImages: Int
    let media: [URL]

    var patientName: String {
        let parts = [lastName, firstName].filter {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return parts.joined(separator: ", ")
    }
}

final class ExamScanner {
    static let shared = ExamScanner()
    private init() {}

    func scan(root: URL) -> [ExamRecord] {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var iniFiles: [URL] = []
        for case let url as URL in enumerator {
            guard url.pathExtension.lowercased() == "ini" else { continue }
            if let text = readText(url),
               text.lowercased().contains("[examdata]") {
                iniFiles.append(url)
            }
        }

        let examFolders = iniFiles.map {
            $0.deletingLastPathComponent().standardizedFileURL
        }

        return iniFiles.compactMap { iniURL in
            parse(iniURL, examFolders: examFolders)
        }.sorted {
            if $0.examDate == $1.examDate {
                return $0.patientName.localizedCaseInsensitiveCompare($1.patientName) == .orderedAscending
            }
            return $0.examDate > $1.examDate
        }
    }

    private func readText(_ url: URL) -> String? {
        if let s = try? String(contentsOf: url, encoding: .utf8) { return s }
        if let s = try? String(contentsOf: url, encoding: .isoLatin1) { return s }
        return try? String(contentsOf: url, encoding: .windowsCP1252)
    }

    private func parse(_ iniURL: URL, examFolders: [URL]) -> ExamRecord? {
        guard let text = readText(iniURL) else { return nil }
        var values: [String: String] = [:]

        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty,
                  !line.hasPrefix("["),
                  let eq = line.firstIndex(of: "=") else { continue }

            let key = String(line[..<eq])
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            let val = String(line[line.index(after: eq)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            values[key] = val
        }

        let folder = iniURL.deletingLastPathComponent()
        let media = discoverMedia(in: folder, examFolders: examFolders)

        return ExamRecord(
            folderURL: folder,
            patientID: values["patid"] ?? values["patientid"] ?? "",
            firstName: values["patfirstname"] ?? values["firstname"] ?? "",
            lastName: values["patlastname"] ?? values["lastname"] ?? "",
            examDate: values["examdate"] ?? "",
            birthDate: values["birthdate"] ?? "",
            sex: values["sex"] ?? "",
            numImages: Int(values["numimages"] ?? "") ?? media.count,
            media: media
        )
    }

    private func discoverMedia(in folder: URL, examFolders: [URL]) -> [URL] {
        let fm = FileManager.default
        let allowed = Set(["wmv", "asf", "avi", "mp4", "mov", "m4v", "mpeg", "mpg"])
        let currentFolder = folder.standardizedFileURL.path
        let examFolderPaths = examFolders.map { $0.standardizedFileURL.path }

        guard let enumerator = fm.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var media: [URL] = []

        for case let url as URL in enumerator {
            guard allowed.contains(url.pathExtension.lowercased()) else { continue }

            let filePath = url.standardizedFileURL.path

            // MPEGVue archives are sometimes nested. Assign each video to the
            // nearest ancestor directory that contains an Exam.ini so one exam
            // cannot steal cine files belonging to a nested exam.
            let owner = examFolderPaths
                .filter { filePath == $0 || filePath.hasPrefix($0 + "/") }
                .max(by: { $0.count < $1.count })

            if owner == currentFolder {
                media.append(url)
            }
        }

        return media.sorted {
            let a = mediaIndex($0)
            let b = mediaIndex($1)
            return a == b ? $0.lastPathComponent < $1.lastPathComponent : a < b
        }
    }

    private func mediaIndex(_ url: URL) -> Int {
        let stem = url.deletingPathExtension().lastPathComponent
        guard let range = stem.range(of: #"\d+"#, options: .regularExpression) else {
            return Int.max
        }
        return Int(stem[range]) ?? Int.max
    }
}

actor FFmpegService {
    static let shared = FFmpegService()

    enum Failure: LocalizedError {
        case missingFFmpeg
        case conversionFailed(String)

        var errorDescription: String? {
            switch self {
            case .missingFFmpeg:
                return "Mesin FFmpeg tidak ditemukan di dalam EchoVue."
            case .conversionFailed(let message):
                return "Gagal memproses cine: \(message)"
            }
        }
    }

    private let fm = FileManager.default

    private var cacheDirectory: URL {
        let root = fm.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let folder = root.appendingPathComponent("EchoVue", isDirectory: true)
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private func ffmpegURL() -> URL? {
        let bundled = Bundle.main.resourceURL?
            .appendingPathComponent("Tools", isDirectory: true)
            .appendingPathComponent("ffmpeg")

        if let bundled,
           fm.isExecutableFile(atPath: bundled.path) {
            return bundled
        }

        for path in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
            if fm.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }

    func playableURL(for source: URL) throws -> URL {
        let ext = source.pathExtension.lowercased()
        if ["mp4", "mov", "m4v"].contains(ext) {
            return source
        }

        guard let ffmpeg = ffmpegURL() else {
            throw Failure.missingFFmpeg
        }

        let meta = try? source.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let token = source.path
            + "|\(meta?.contentModificationDate?.timeIntervalSince1970 ?? 0)"
            + "|\(meta?.fileSize ?? 0)"

        let digest = SHA256.hash(data: Data(token.utf8))
            .map { String(format: "%02x", $0) }
            .joined()

        let finalURL = cacheDirectory
            .appendingPathComponent(String(digest.prefix(24)))
            .appendingPathExtension("mp4")

        if fm.fileExists(atPath: finalURL.path) {
            return finalURL
        }

        let tempURL = cacheDirectory
            .appendingPathComponent(String(digest.prefix(24)) + "-tmp")
            .appendingPathExtension("mp4")

        try? fm.removeItem(at: tempURL)

        do {
            try run(ffmpeg, arguments: [
                "-y", "-hide_banner", "-loglevel", "error",
                "-i", source.path,
                "-map", "0:v:0", "-an",
                "-c:v", "h264_videotoolbox",
                "-b:v", "8M",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                tempURL.path
            ])
        } catch {
            try? fm.removeItem(at: tempURL)
            try run(ffmpeg, arguments: [
                "-y", "-hide_banner", "-loglevel", "error",
                "-i", source.path,
                "-map", "0:v:0", "-an",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "15",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                tempURL.path
            ])
        }

        try? fm.removeItem(at: finalURL)
        try fm.moveItem(at: tempURL, to: finalURL)
        return finalURL
    }

    func thumbnailURL(for source: URL) throws -> URL {
        if let nearby = nearbyThumbnail(for: source) {
            return nearby
        }

        guard let ffmpeg = ffmpegURL() else {
            throw Failure.missingFFmpeg
        }

        let digest = SHA256.hash(data: Data(source.path.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        let out = cacheDirectory
            .appendingPathComponent("thumb-" + String(digest.prefix(20)))
            .appendingPathExtension("jpg")

        if fm.fileExists(atPath: out.path) {
            return out
        }

        try run(ffmpeg, arguments: [
            "-y", "-hide_banner", "-loglevel", "error",
            "-ss", "0.15",
            "-i", source.path,
            "-frames:v", "1",
            "-vf", "scale=260:-2:flags=lanczos",
            "-q:v", "2",
            out.path
        ])
        return out
    }

    private func nearbyThumbnail(for source: URL) -> URL? {
        let folder = source.deletingLastPathComponent()
        let stem = source.deletingPathExtension().lastPathComponent

        var candidates: [String] = [
            "\(stem)_small.jpg",
            "\(stem)_small.jpeg",
            "\(stem)_small.png"
        ]

        if let open = stem.lastIndex(of: "("),
           stem.hasSuffix(")") {
            let base = String(stem[..<open])
            let suffix = String(stem[open...])
            candidates.append(contentsOf: [
                "\(base)_small\(suffix).jpg",
                "\(base)_small\(suffix).jpeg",
                "\(base)_small\(suffix).png"
            ])
        }

        for name in candidates {
            let candidate = folder.appendingPathComponent(name)
            if fm.fileExists(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    private func run(_ executable: URL, arguments: [String]) throws {
        let process = Process()
        let stderr = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardError = stderr
        process.standardOutput = Pipe()

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let data = stderr.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: data, encoding: .utf8)
                ?? "FFmpeg exit \(process.terminationStatus)"
            throw Failure.conversionFailed(
                message.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
    }
}

@MainActor
final class LibraryModel: ObservableObject {
    @Published var exams: [ExamRecord] = []
    @Published var search = ""
    @Published var busy = false
    @Published var error: String?

    var filtered: [ExamRecord] {
        let query = search
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !query.isEmpty else { return exams }

        return exams.filter {
            "\($0.patientID) \($0.patientName) \($0.examDate) \($0.birthDate)"
                .lowercased()
                .contains(query)
        }
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Buka"
        panel.message = "Pilih folder arsip MPEGVue yang berisi Exam.ini"

        guard panel.runModal() == .OK,
              let root = panel.url else { return }

        busy = true
        error = nil

        Task.detached(priority: .userInitiated) {
            let result = ExamScanner.shared.scan(root: root)
            await MainActor.run {
                self.exams = result
                self.busy = false
            }
        }
    }
}

@MainActor
final class PlayerModel: ObservableObject {
    @Published var player = AVPlayer()
    @Published var preparing = false
    @Published var isPlaying = false
    @Published var error: String?

    func load(_ source: URL) {
        preparing = true
        error = nil

        Task {
            do {
                let playable = try await FFmpegService.shared.playableURL(for: source)
                let item = AVPlayerItem(url: playable)
                player.replaceCurrentItem(with: item)
                player.play()
                isPlaying = true
                preparing = false
            } catch {
                preparing = false
                self.error = error.localizedDescription
            }
        }
    }

    func toggle() {
        if isPlaying {
            player.pause()
        } else {
            player.play()
        }
        isPlaying.toggle()
    }

    func loopIfCurrent(_ notification: Notification) {
        guard let item = notification.object as? AVPlayerItem,
              item === player.currentItem else { return }
        player.seek(to: .zero)
        player.play()
        isPlaying = true
    }
}

struct AVSurface: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .none
        view.videoGravity = .resizeAspect
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        view.player = player
    }
}

struct ExamListView: View {
    @ObservedObject var model: LibraryModel
    let open: (ExamRecord) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button(action: model.chooseFolder) {
                    Label("Buka Folder MPEGVue", systemImage: "folder")
                }

                Spacer()

                TextField("Cari pasien / ID / tanggal", text: $model.search)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 320)

                if model.busy {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .padding(12)
            .background(.bar)

            Divider()

            if model.filtered.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "waveform.path.ecg.rectangle")
                        .font(.system(size: 56))
                        .foregroundStyle(.secondary)

                    Text("Belum ada pemeriksaan")
                        .font(.title2.bold())

                    Text("Pilih folder MPEGVue. EchoVue membaca Exam.ini dan WMV secara lokal.")
                        .foregroundStyle(.secondary)

                    Button("Buka Folder", action: model.chooseFolder)
                        .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(model.filtered) { exam in
                    Button {
                        open(exam)
                    } label: {
                        HStack(spacing: 16) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(exam.patientName.isEmpty ? "Tanpa nama" : exam.patientName)
                                    .font(.headline)
                                Text("ID \(exam.patientID)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()

                            VStack(alignment: .trailing, spacing: 4) {
                                Text(exam.examDate.isEmpty ? "Buka" : exam.examDate)
                                    .fontWeight(.medium)
                                Text("\(exam.media.count) cine")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .contentShape(Rectangle())
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

struct CineThumbView: View {
    let index: Int
    let url: URL
    let selected: Bool
    let onSelect: () -> Void

    @State private var thumbnail: URL?

    var body: some View {
        Button(action: onSelect) {
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(.black)
                    .aspectRatio(4 / 3, contentMode: .fit)

                if let thumbnail,
                   let image = NSImage(contentsOf: thumbnail) {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }

                Text("\(index + 1)")
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(.yellow)
                    .padding(5)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 6)
                    .stroke(selected ? Color.accentColor : Color.gray.opacity(0.35),
                            lineWidth: selected ? 3 : 1)
            }
        }
        .buttonStyle(.plain)
        .task(id: url) {
            thumbnail = try? await FFmpegService.shared.thumbnailURL(for: url)
        }
    }
}

struct ExamView: View {
    let exam: ExamRecord
    let close: () -> Void

    @StateObject private var playerModel = PlayerModel()
    @State private var selectedIndex = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: close) {
                    Label("Daftar pemeriksaan", systemImage: "chevron.left")
                }

                Spacer()

                Text(exam.patientName.isEmpty ? "EchoVue" : exam.patientName)
                    .font(.headline)

                Spacer()

                Button {
                    NSApp.keyWindow?.toggleFullScreen(nil)
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .help("Fullscreen")
            }
            .padding(10)
            .background(.bar)

            HSplitView {
                ScrollView {
                    LazyVGrid(
                        columns: [GridItem(.flexible()), GridItem(.flexible())],
                        spacing: 8
                    ) {
                        ForEach(Array(exam.media.enumerated()), id: \.offset) { pair in
                            let index = pair.offset
                            let url = pair.element

                            CineThumbView(
                                index: index,
                                url: url,
                                selected: index == selectedIndex
                            ) {
                                selectedIndex = index
                                playerModel.load(url)
                            }
                        }
                    }
                    .padding(8)
                }
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 320)
                .background(Color(nsColor: .underPageBackgroundColor))

                VStack(spacing: 0) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(exam.patientName)
                                .font(.title3.bold())

                            Text("ID \(exam.patientID)  •  Exam \(exam.examDate)  •  DOB \(exam.birthDate)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        Text("\(exam.media.count) cine")
                            .foregroundStyle(.secondary)
                    }
                    .padding(12)

                    ZStack {
                        Color.black

                        AVSurface(player: playerModel.player)

                        if playerModel.preparing {
                            VStack(spacing: 10) {
                                ProgressView()
                                    .controlSize(.large)
                                Text("Menyiapkan WMV…")
                            }
                            .padding(18)
                            .background(.ultraThinMaterial,
                                        in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                    HStack(spacing: 16) {
                        Button {
                            goPrevious()
                        } label: {
                            Image(systemName: "chevron.left")
                        }

                        Button {
                            playerModel.toggle()
                        } label: {
                            Image(systemName: playerModel.isPlaying ? "pause.fill" : "play.fill")
                        }
                        .keyboardShortcut(.space, modifiers: [])

                        Button {
                            goNext()
                        } label: {
                            Image(systemName: "chevron.right")
                        }

                        Spacer()

                        Text("WMV diproses lokal • tidak di-upload")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(Color(nsColor: .controlBackgroundColor))
                }
                .frame(minWidth: 760)
            }
        }
        .onAppear {
            if let first = exam.media.first {
                playerModel.load(first)
            }
        }
        .onReceive(
            NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime)
        ) { notification in
            playerModel.loopIfCurrent(notification)
        }
        .alert(
            "EchoVue",
            isPresented: Binding(
                get: { playerModel.error != nil },
                set: { shown in
                    if !shown { playerModel.error = nil }
                }
            )
        ) {
            Button("OK", role: .cancel) {
                playerModel.error = nil
            }
        } message: {
            Text(playerModel.error ?? "")
        }
    }

    private func goPrevious() {
        guard !exam.media.isEmpty else { return }
        selectedIndex = max(0, selectedIndex - 1)
        playerModel.load(exam.media[selectedIndex])
    }

    private func goNext() {
        guard !exam.media.isEmpty else { return }
        selectedIndex = min(exam.media.count - 1, selectedIndex + 1)
        playerModel.load(exam.media[selectedIndex])
    }
}

@main
struct EchoVueApp: App {
    @StateObject private var libraryModel = LibraryModel()
    @State private var selectedExam: ExamRecord?

    var body: some Scene {
        WindowGroup("EchoVue") {
            Group {
                if let selectedExam {
                    ExamView(exam: selectedExam) {
                        self.selectedExam = nil
                    }
                } else {
                    ExamListView(model: libraryModel) { exam in
                        selectedExam = exam
                    }
                }
            }
            .frame(minWidth: 1050, minHeight: 720)
        }
    }
}
