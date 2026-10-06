/**
 * Raid night on the prototype's server (#197): forty-five more people, all in
 * #general and in its voice, in every face and color, the way a guild of
 * fifty looks. With the evening's own people that's 48 in one voice room and
 * more than enough on the server for the list to fold everyone you don't
 * talk to.
 */
import type { Style } from "../../../src/generated/Style";
import type { User } from "../../../src/generated/User";
import type { GatewayState } from "../../../src/lib/gateway";

const NAMES = [
  "Kestrel", "Bramble", "Oxbow", "Nyx", "Grimwald", "Pip", "Thistle", "Rook", "Wren", "Cinder",
  "Corvin", "Dusk", "Fennick", "Gale", "Hollis", "Ivo", "Jarrah", "Kip", "Lark", "Moss",
  "Nettle", "Orin", "Pell", "Quince", "Rue", "Sorrel", "Tamsin", "Umber", "Vale", "Wick",
  "Yarrow", "Zephyr", "Briar", "Calla", "Dax", "Elko", "Flint", "Garnet", "Hazel", "Isolde",
  "Jory", "Kaito", "Lumen", "Mabry", "Odessa",
];
const COLORS = ["ember", "rust", "amber", "brass", "lime", "fern", "mint", "teal", "cyan", "sky", "azure", "indigo", "violet", "orchid", "rose", "slate"];
const FACES = ["geist-sans", "space-grotesk", "newsreader", "instrument-serif", "jetbrains-mono", "ibm-plex-sans", "silkscreen", "geist-mono", "inter", "ibm-plex-mono", "commit-mono", "departure-mono"];

/** The raiders, by user id, in the order they joined. */
export const RAIDERS: User[] = NAMES.map((name, n) => {
  const color = COLORS[n % COLORS.length] ?? "slate";
  const to = COLORS[(n * 5 + 3) % COLORS.length] ?? "slate";
  const style: Style = {
    font_key: FACES[n % FACES.length] ?? "geist-sans",
    weight: n % 3 === 0 ? 700 : 400,
    italic: n % 4 === 1,
    fill: n % 6 === 2 ? { kind: "gradient", from: color, to } : { kind: "solid", color },
    effect: n % 11 === 5 ? "glow" : "none",
    msg_font_key: null,
  };
  return {
    id: `u-raid-${n}`,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    is_cohost: false,
    style,
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
});

/** The evening with the raid in #general and its voice. */
export function raid(state: GatewayState): GatewayState {
  const ids = RAIDERS.map((user) => user.id);
  return {
    ...state,
    users: [...state.users, ...RAIDERS],
    presence: [...state.presence, ...ids.map((user_id) => ({ user_id, state: "in_room" as const, room_id: "r-general", away_message: null }))],
    occupancy: { ...state.occupancy, "r-general": [...(state.occupancy["r-general"] ?? []), ...ids] },
    voice: {
      ...state.voice,
      "r-general": [
        ...(state.voice["r-general"] ?? []),
        // A few have their microphones off, as in any raid.
        ...ids.map((user_id, n) => ({ session_id: `s-raid-${n}`, user_id, controls: { muted: n % 9 === 4, deafened: false } })),
      ],
    },
  };
}
