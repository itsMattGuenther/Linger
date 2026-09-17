import { useState } from "react";
import type { User } from "../generated/User";
import { ApiError, type AuthedApi } from "../lib/api";

/**
 * The host's one destructive control, inside Host tools → people (T-413).
 *
 * "Remove from the server", never kick and never ban — SPEC §1's vocabulary,
 * and there is no ban to offer: it would need something durable to ban by, and
 * Linger stores no addresses and no device ids. Confirmation names the person
 * and describes the loss of access before anything is changed.
 *
 * Nothing is reset on success: the server fans out `user.remove`, the store
 * drops them from `users`, and this card is unmounted with them.
 */
export default function Removal({ api, user }: { api: AuthedApi; user: User }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.removeUser(user.id);
    } catch (error) {
      setProblem(
        error instanceof ApiError ? error.message : "Couldn't remove them.",
      );
      setBusy(false);
      setAsking(false);
    }
  };

  return (
    <div className="person-host">
      {asking ? (
        <>
          <p className="person-host-note">
            Remove {user.display_name} from this server?
          </p>
          {/* Said before the click rather than apologised for after it. The
              part people get wrong is the reversibility, so lead with that. */}
          <p className="person-host-note meta">
            They lose their sign-in and any invite links they made. What they
            wrote stays. You can let them back in from the host panel.
          </p>
          <p className="person-mine">
            <button
              type="button"
              className="person-edit person-danger meta"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "removing…" : "yes, remove"}
            </button>
            <button
              type="button"
              className="person-edit meta"
              disabled={busy}
              onClick={() => setAsking(false)}
            >
              keep them
            </button>
          </p>
        </>
      ) : (
        <p className="person-mine">
          <button
            type="button"
            className="person-edit meta"
            onClick={() => {
              setProblem(null);
              setAsking(true);
            }}
          >
            remove from the server
          </button>
        </p>
      )}
      {problem === null ? null : <p className="person-host-note">{problem}</p>}
    </div>
  );
}
