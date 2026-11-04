import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return response({ error: "Method not allowed." }, 405);
  }

  const authorization = request.headers.get("Authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "");
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !projectUrl || !anonKey || !serviceRoleKey) {
    return response({ error: "Cleanup service is not configured or the caller is unauthenticated." }, 401);
  }

  let body: { reservation_id?: string; discard_guest?: boolean };
  try {
    body = await request.json();
  } catch {
    return response({ error: "Invalid request body." }, 400);
  }

  const publicClient = createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const adminClient = createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: { user }, error: authError } = await publicClient.auth.getUser(token);
  if (authError || !user) {
    return response({ error: "The caller's guest session is no longer valid." }, 401);
  }

  if (body.discard_guest === true) {
    const { data: owned, error: ownedError } = await adminClient
      .from("reservations")
      .select("id")
      .eq("owner_id", user.id)
      .limit(1);
    const { data: participation, error: participationError } = await adminClient
      .from("room_participants")
      .select("reservation_id")
      .eq("user_id", user.id)
      .limit(1);
    if (ownedError || participationError) {
      console.error("Could not verify whether the guest account is in use.", ownedError || participationError);
      return response({ error: "Could not verify whether the guest account is in use." }, 500);
    }
    if (owned.length > 0 || participation.length > 0) {
      return response({ error: "This guest account still owns or participates in a reservation." }, 409);
    }
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);
    if (deleteError) {
      console.error("Could not remove the unused anonymous account.", deleteError);
      return response({ error: "The unused guest account could not be deleted." }, 500);
    }
    return response({ deleted: true }, 200);
  }

  const reservationId = body.reservation_id;
  if (typeof reservationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservationId)) {
    return response({ error: "Invalid reservation ID." }, 400);
  }

  const { data: cleanup, error: cleanupError } = await adminClient
    .from("room_cleanup_queue")
    .select("reservation_id,storage_paths,user_ids")
    .eq("reservation_id", reservationId)
    .maybeSingle();
  if (cleanupError) {
    console.error("Could not read the room cleanup request.", cleanupError);
    return response({ error: "Could not read the room cleanup request." }, 500);
  }
  if (!cleanup || !cleanup.user_ids.includes(user.id)) {
    return response({ error: "No cleanup request is available for this guest." }, 403);
  }

  for (let index = 0; index < cleanup.storage_paths.length; index += 100) {
    const paths = cleanup.storage_paths.slice(index, index + 100);
    const { error } = await adminClient.storage.from("room-shares").remove(paths);
    if (error) {
      console.error("Could not remove room files from storage.", error);
      return response({ error: "Shared files could not be deleted." }, 500);
    }
  }

  const otherUsers = cleanup.user_ids.filter((id: string) => id !== user.id);
  for (const userId of otherUsers) {
    const { error } = await adminClient.auth.admin.deleteUser(userId);
    if (error) {
      console.error("Could not remove an anonymous room account.", error);
      return response({ error: "Guest account cleanup is incomplete." }, 500);
    }
  }

  const { error: queueError } = await adminClient
    .from("room_cleanup_queue")
    .delete()
    .eq("reservation_id", reservationId);
  if (queueError) {
    console.error("Could not remove the room cleanup record.", queueError);
    return response({ error: "Room cleanup is incomplete." }, 500);
  }

  const { error: callerError } = await adminClient.auth.admin.deleteUser(user.id);
  if (callerError) {
    console.error("Could not remove the final anonymous room account.", callerError);
    return response({ error: "Room account cleanup is incomplete." }, 500);
  }

  return response({ deleted: true }, 200);
});

function response(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
