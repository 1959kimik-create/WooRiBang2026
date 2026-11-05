(() => {
  "use strict";

  const endpoint = "https://kxurpuucxcdhqmviahht.supabase.co";
  const publicKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt4dXJwdXVjeGNkaHFtdmlhaGh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyODM3ODIsImV4cCI6MjEwNjg1OTc4Mn0.1lz1jEkVTIpGZRoA3HMSfghzhXMkuFY4rdoCIYP6scw";

  if (!window.supabase || !window.supabase.createClient) {
    window.roomBackend = { available: false, error: new Error("Supabase client library is unavailable.") };
    return;
  }

  const client = window.supabase.createClient(endpoint, publicKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      storage: window.sessionStorage
    }
  });

  function unwrap(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  async function ensureGuestSession() {
    const { data: { session } = {}, error } = await client.auth.getSession();
    if (error) throw error;
    if (session) return session;
    const { data, error: signInError } = await client.auth.signInAnonymously();
    if (signInError) throw signInError;
    if (!data.session) throw new Error("Anonymous sign-in returned no session.");
    return data.session;
  }

  window.roomBackend = {
    available: true,
    client,
    async connect() {
      return ensureGuestSession();
    },
    async checkConnection() {
      return unwrap(await client.rpc("room_schedule", {
        p_from: new Date().toISOString(),
        p_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      }));
    },
    async schedule(from, until) {
      return unwrap(await client.rpc("room_schedule", {
        p_from: from.toISOString(),
        p_until: until.toISOString()
      }));
    },
    async bookings(roomId) {
      return unwrap(await client.rpc("room_bookings", { p_room_id: roomId }));
    },
    async reservationForEntry(reservationId) {
      const rows = unwrap(await client.rpc("reservation_for_entry", {
        p_reservation_id: reservationId
      }));
      return rows[0] || null;
    },
    async reserve(roomId, startsAt, password) {
      return unwrap(await client.rpc("reserve_room", {
        p_room_id: roomId,
        p_starts_at: startsAt.toISOString(),
        p_password: password
      }));
    },
    async join(reservationId, password, displayName) {
      return unwrap(await client.rpc("join_room", {
        p_reservation_id: reservationId,
        p_password: password,
        p_display_name: displayName
      }));
    },
    async messages(reservationId) {
      return unwrap(await client.from("room_messages")
        .select("id,sender_id,sender_name,body,input_type,created_at")
        .eq("reservation_id", reservationId)
        .order("created_at", { ascending: true }));
    },
    async participants(reservationId) {
      return unwrap(await client.from("room_participants")
        .select("user_id,display_name,joined_at")
        .eq("reservation_id", reservationId)
        .is("left_at", null)
        .order("joined_at", { ascending: true }));
    },
    async sharedFiles(reservationId) {
      return unwrap(await client.from("shared_files")
        .select("id,original_name,storage_path,external_url,created_at")
        .eq("reservation_id", reservationId)
        .order("created_at", { ascending: true }));
    },
    async downloadSharedFile(storagePath) {
      return unwrap(await client.storage.from("room-shares").download(storagePath));
    },
    async deleteSharedFile(reservationId, fileId) {
      const file = unwrap(await client.from("shared_files")
        .select("storage_path")
        .eq("id", fileId)
        .eq("reservation_id", reservationId)
        .maybeSingle());
      if (!file) throw new Error("파일 삭제 권한이 없거나 이미 삭제된 파일입니다.");
      if (file.storage_path) {
        const { error } = await client.storage.from("room-shares").remove([file.storage_path]);
        if (error) {
          error.shareStage = "storage-delete";
          throw error;
        }
      }
      const deleted = unwrap(await client.from("shared_files")
        .delete()
        .eq("id", fileId)
        .eq("reservation_id", reservationId)
        .select("id"));
      if (!deleted.length) throw new Error("파일 삭제 권한이 없거나 이미 삭제된 파일입니다.");
    },
    async uploadSharedFile(reservationId, file) {
      const { data: { user }, error: userError } = await client.auth.getUser();
      if (userError) throw userError;
      if (!user) throw new Error("Sign in is required to share a file.");
      const safeName = file.name.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim() || "shared-file";
      const path = `${reservationId}/${user.id}/${crypto.randomUUID()}`;
      const { error: uploadError } = await client.storage.from("room-shares")
        .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (uploadError) {
        uploadError.shareStage = "upload";
        throw uploadError;
      }
      try {
        return unwrap(await client.rpc("register_shared_file", {
          p_reservation_id: reservationId,
          p_original_name: safeName,
          p_storage_path: path,
          p_external_url: null
        }));
      } catch (error) {
        const { error: removeError } = await client.storage.from("room-shares").remove([path]);
        if (removeError) console.error("Failed to remove an unregistered shared file.", removeError);
        error.shareStage = "register";
        throw error;
      }
    },
    async shareLink(reservationId, url) {
      const parsed = new URL(url);
      return unwrap(await client.rpc("register_shared_file", {
        p_reservation_id: reservationId,
        p_original_name: parsed.hostname,
        p_storage_path: null,
        p_external_url: parsed.href
      }));
    },
    async sendMessage(reservationId, body, inputType) {
      return unwrap(await client.rpc("send_room_message", {
        p_reservation_id: reservationId,
        p_body: body,
        p_input_type: inputType
      }));
    },
    async extend(reservationId) {
      return unwrap(await client.rpc("extend_room", { p_reservation_id: reservationId }));
    },
    async leave(reservationId) {
      return unwrap(await client.rpc("leave_room", { p_reservation_id: reservationId }));
    },
    async cleanupRoom(reservationId) {
      const result = await client.functions.invoke("cleanup-room", {
        body: { reservation_id: reservationId }
      });
      if (result.error) {
        const context = result.error.context;
        if (context instanceof Response) {
          const body = await context.clone().text();
          if (body) {
            try {
              const payload = JSON.parse(body);
              if (typeof payload.error === "string") result.error.message = payload.error;
            } catch {
              result.error.message = body.slice(0, 240);
            }
          }
        }
        throw result.error;
      }
      return result.data;
    },
    async discardUnusedGuest() {
      return unwrap(await client.functions.invoke("cleanup-room", {
        body: { discard_guest: true }
      }));
    },
    async signOutAndForget() {
      const { error } = await client.auth.signOut({ scope: "local" });
      const { data, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw sessionError;
      if (data.session) {
        throw error || new Error("The guest session could not be cleared from this browser.");
      }
    },
    subscribe(reservationId, identity, onChange, onSignal, onPresence) {
      const topic = `room:${reservationId}`;
      const channel = client.channel(topic, {
        config: { private: true, presence: { key: identity.userId } }
      })
        .on("broadcast", { event: "signal" }, ({ payload }) => {
          if (payload?.to === identity.userId && payload.from && payload.signal) {
            onSignal(payload.from, payload.signal);
          }
        })
        .on("presence", { event: "sync" }, () => {
          const participants = Object.values(channel.presenceState()).flat()
            .filter((entry) => entry?.user_id && entry.display_name);
          const unique = [...new Map(participants.map((entry) => [entry.user_id, entry])).values()];
          onPresence(unique);
        })
        .on("postgres_changes", {
          event: "*", schema: "public", table: "room_messages",
          filter: `reservation_id=eq.${reservationId}`
        }, () => onChange("messages"))
        .on("postgres_changes", {
          event: "*", schema: "public", table: "shared_files",
          filter: `reservation_id=eq.${reservationId}`
        }, () => onChange("shared"))
        .on("postgres_changes", {
          event: "UPDATE", schema: "public", table: "reservations",
          filter: `id=eq.${reservationId}`
        }, () => onChange("reservation"))
        .subscribe((status, error) => {
          if (status === "SUBSCRIBED") {
            void channel.track({
              user_id: identity.userId,
              display_name: identity.displayName,
              camera_enabled: identity.cameraEnabled,
              microphone_enabled: identity.microphoneEnabled
            }).then(() => {
              const participants = Object.values(channel.presenceState()).flat()
                .filter((entry) => entry?.user_id && entry.display_name);
              onPresence([...new Map(participants.map((entry) => [entry.user_id, entry])).values()]);
            }).catch((trackError) => onChange("error", trackError));
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            onChange("error", error || new Error(`Realtime connection ${status.toLowerCase()}.`));
          }
        });
      return {
        async updatePresence(presence) {
          const result = await channel.track({
            user_id: identity.userId,
            ...presence
          });
          if (result !== "ok") throw new Error(`Realtime presence update failed: ${result}`);
        },
        async sendSignal(to, signal) {
          const result = await channel.send({
            type: "broadcast",
            event: "signal",
            payload: { from: identity.userId, to, signal }
          });
          if (result !== "ok") throw new Error(`Realtime signal send failed: ${result}`);
        },
        unsubscribe() {
          void client.removeChannel(channel);
        }
      };
    }
  };
})();
