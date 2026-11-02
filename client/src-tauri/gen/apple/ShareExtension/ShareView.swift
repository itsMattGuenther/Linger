import SwiftUI

/// The share window (#820, SPEC §4.15), inside the iPhone's share sheet:
/// what's being shared and a message box, a search box, every conversation
/// (the ones shared to last on top), and Send. In Linger's own colours, with
/// the system's type, so the iPhone's Text Size is followed as it is in the
/// app (#690).
struct ShareView: View {
  @ObservedObject var model: ShareModel
  @FocusState private var typing: Bool

  var body: some View {
    let colors = model.colors
    VStack(spacing: 0) {
      header
      colors.hairline.frame(height: 1)
      if let blocked = model.blocked {
        Blocked(words: blocked, colors: colors) { model.close() }
      } else if model.stage == .gathering {
        Spacer()
        ProgressView().tint(colors.textSecondary)
        Text("Getting it ready…")
          .font(.subheadline)
          .foregroundColor(colors.textSecondary)
          .padding(.top, 8)
        Spacer()
      } else {
        shared
        searchBox
        conversations
        footer
      }
    }
    .background(colors.background.ignoresSafeArea())
    .preferredColorScheme(.dark)
  }

  // MARK: - Parts

  private var header: some View {
    let colors = model.colors
    return ZStack {
      Text("Share to Linger")
        .font(.headline)
        .foregroundColor(colors.text)
        .accessibilityAddTraits(.isHeader)
      HStack {
        Button("Cancel") { model.close() }
          .foregroundColor(colors.textSecondary)
          .disabled(model.stage == .sending)
        Spacer()
        if model.blocked == nil {
          Button(action: send) {
            Group {
              if model.stage == .sending {
                ProgressView().tint(colors.onAccent)
              } else {
                Text("Send").font(.headline)
              }
            }
            .frame(minWidth: 52)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Capsule().fill(model.canSend || model.stage == .sending ? colors.accent : colors.raised))
            .foregroundColor(model.canSend ? colors.onAccent : colors.textMuted)
          }
          .disabled(!model.canSend)
          .accessibilityLabel(model.chosenRow == nil ? "Send" : "Send to \(model.destination)")
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }

  /// What's being shared, and the message box beside it.
  private var shared: some View {
    let colors = model.colors
    return VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 16) {
        VStack(spacing: 6) {
          Previews(previews: model.previews, colors: colors)
          if model.files.count > 1 {
            Text(model.what)
              .font(.caption2)
              .foregroundColor(colors.textMuted)
              .lineLimit(1)
          }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sharing \(model.what)")
        message
      }
      .padding(12)
      .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(colors.raised))
      if let note = model.note {
        Text(note).font(.footnote).foregroundColor(colors.textMuted)
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 12)
  }

  @ViewBuilder private var message: some View {
    let colors = model.colors
    let placeholder = Text("Add a message").foregroundColor(colors.textMuted)
    Group {
      if #available(iOS 16.0, *) {
        TextField("", text: $model.message, prompt: placeholder, axis: .vertical).lineLimit(1...5)
      } else {
        TextField("", text: $model.message, prompt: placeholder)
      }
    }
    .font(.body)
    .foregroundColor(colors.text)
    .focused($typing)
    .disabled(model.stage != .picking)
    .accessibilityLabel("Message")
  }

  private var searchBox: some View {
    let colors = model.colors
    return HStack(spacing: 8) {
      Image(systemName: "magnifyingglass").foregroundColor(colors.textMuted)
      TextField("", text: $model.search, prompt: Text("Find a room or person").foregroundColor(colors.textMuted))
        .font(.body)
        .foregroundColor(colors.text)
        .disableAutocorrection(true)
        .textInputAutocapitalization(.never)
        .submitLabel(.search)
        .accessibilityLabel("Find a room or person")
      if !model.search.isEmpty {
        Button {
          model.search = ""
        } label: {
          Image(systemName: "xmark.circle.fill").foregroundColor(colors.textMuted)
        }
        .accessibilityLabel("Clear")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(colors.field))
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 4)
  }

  private var conversations: some View {
    let colors = model.colors
    let sections = model.sections
    return ScrollView {
      LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
        if sections.isEmpty {
          Text(model.search.isEmpty ? "Nothing to share to yet." : "Nobody and nothing by that name.")
            .font(.subheadline)
            .foregroundColor(colors.textMuted)
            .padding(.horizontal, 12)
            .padding(.top, 16)
        }
        ForEach(sections, id: \.self) { section in
          Section {
            // A conversation can be in Recent and under its server: each row
            // is known by its section too, or the lazy list draws one blank.
            ForEach(section.rows.map { Placed(section: section.title, row: $0) }, id: \.self) { placed in
              let row = placed.row
              Row(
                row: row,
                label: row.conversation.name,
                server: section.namesServers ? row.serverName : nil,
                chosen: model.chosen == row.target,
                busy: model.stage != .picking,
                colors: colors
              ) {
                typing = false
                model.choose(row)
              }
            }
          } header: {
            if let title = section.title {
              Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundColor(colors.textMuted)
                .padding(.horizontal, 12)
                .padding(.top, 14)
                .padding(.bottom, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(colors.background)
                .accessibilityAddTraits(.isHeader)
            }
          }
        }
      }
      .padding(.horizontal, 8)
      .padding(.bottom, 16)
    }
  }

  /// Sending, sent, or why it didn't go.
  @ViewBuilder private var footer: some View {
    let colors = model.colors
    if model.stage == .sending || model.stage == .sent || model.failure != nil {
      VStack(alignment: .leading, spacing: 8) {
        colors.hairline.frame(height: 1).padding(.horizontal, -16)
        if model.stage == .sent {
          Label("Sent", systemImage: "checkmark.circle.fill")
            .font(.headline)
            .foregroundColor(colors.accent)
        } else if model.stage == .sending {
          ProgressView(value: model.progress).tint(colors.accent)
          Text("Sending \(model.what) to \(model.destination)…")
            .font(.footnote)
            .foregroundColor(colors.textSecondary)
            .lineLimit(2)
        } else if let failure = model.failure {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill").foregroundColor(colors.danger)
            Text(failure).font(.subheadline).foregroundColor(colors.text)
          }
          Button("Try again", action: send)
            .font(.subheadline.weight(.semibold))
            .foregroundColor(colors.accent)
            .disabled(!model.canSend)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(colors.background)
    }
  }

  private func send() {
    typing = false
    model.send()
  }
}

/// One conversation: its mark, its name (a room's without "#", which its
/// mark is), and a check when it's the one.
private struct Row: View {
  let row: ShareRow
  let label: String
  /// Its server's name, when found among several.
  let server: String?
  let chosen: Bool
  let busy: Bool
  let colors: ShareColors
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Mark(conversation: row.conversation, colors: colors)
        VStack(alignment: .leading, spacing: 2) {
          Text(label)
            .font(.body)
            .foregroundColor(row.unavailable == nil ? colors.text : colors.textMuted)
            .lineLimit(1)
          if let server {
            Text(server).font(.caption).foregroundColor(colors.textMuted).lineLimit(1)
          }
          if let why = row.unavailable {
            Text(why).font(.caption).foregroundColor(colors.textMuted).lineLimit(2)
          }
        }
        Spacer(minLength: 8)
        if chosen {
          Image(systemName: "checkmark.circle.fill")
            .font(.title3)
            .foregroundColor(colors.accent)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(minHeight: 48)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(chosen ? colors.chosen : Color.clear)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(chosen ? colors.chosenEdge : Color.clear, lineWidth: 1)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(row.unavailable != nil || busy)
    .accessibilityLabel([label, server, row.unavailable].compactMap { $0 }.joined(separator: ", "))
    .accessibilityAddTraits(chosen ? .isSelected : [])
  }
}

/// A room's "#", a person's colour, or a group's people's colours, as the
/// list's markers draw them.
private struct Mark: View {
  let conversation: ShareList.Conversation
  let colors: ShareColors

  var body: some View {
    ZStack {
      if conversation.kind == "room" {
        Text("#").font(.body.weight(.semibold)).foregroundColor(colors.textMuted)
      } else {
        HStack(spacing: -4) {
          ForEach(Array(conversation.colors.prefix(3).enumerated()), id: \.offset) { _, hex in
            Circle()
              .fill(swatch(hex))
              .frame(width: 10, height: 10)
              .overlay(Circle().stroke(colors.background, lineWidth: 1.5))
          }
        }
      }
    }
    .frame(width: 28, height: 28)
    .accessibilityHidden(true)
  }

  private func swatch(_ hex: String) -> Color {
    let (red, green, blue, alpha) = rgba(hex) ?? (0.5, 0.5, 0.5, 1)
    return Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
  }
}

/// Up to three of what's being shared, overlapping, and how many more.
private struct Previews: View {
  let previews: [SharePreview]
  let colors: ShareColors

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      ForEach(Array(previews.prefix(3).enumerated().reversed()), id: \.element.id) { index, preview in
        tile(preview)
          .rotationEffect(.degrees(Double(index) * 6))
          .offset(x: CGFloat(index) * 5, y: CGFloat(index) * -3)
      }
      if previews.count > 3 {
        Text("+\(previews.count - 3)")
          .font(.caption2.weight(.semibold))
          .padding(.horizontal, 5)
          .padding(.vertical, 2)
          .background(Capsule().fill(colors.background))
          .foregroundColor(colors.text)
          .offset(x: 6, y: 6)
      }
    }
    .frame(width: 68, height: 64, alignment: .leading)
  }

  @ViewBuilder private func tile(_ preview: SharePreview) -> some View {
    if let image = preview.image {
      Image(uiImage: image)
        .resizable()
        .scaledToFill()
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(colors.hairline, lineWidth: 1))
    } else {
      VStack(spacing: 2) {
        Image(systemName: preview.symbol).font(.title3).foregroundColor(colors.textSecondary)
        Text(preview.name)
          .font(.caption2)
          .foregroundColor(colors.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .padding(4)
      .frame(width: 56, height: 56)
      .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(colors.field))
      .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(colors.hairline, lineWidth: 1))
    }
  }
}

/// The window can't share: why, and Close.
private struct Blocked: View {
  let words: String
  let colors: ShareColors
  let close: () -> Void

  var body: some View {
    VStack(spacing: 16) {
      Spacer()
      Image(systemName: "square.and.arrow.up").font(.largeTitle).foregroundColor(colors.textMuted)
      Text(words)
        .font(.body)
        .foregroundColor(colors.text)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
      Button("Close", action: close)
        .font(.headline)
        .foregroundColor(colors.accent)
      Spacer()
    }
    .frame(maxWidth: .infinity)
  }
}

/// A row where it's shown: the same conversation can be in Recent and under
/// its server, and the lazy list needs each to be its own.
private struct Placed: Hashable {
  let section: String?
  let row: ShareRow
}
