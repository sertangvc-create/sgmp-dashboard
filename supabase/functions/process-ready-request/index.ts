import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async () => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const openaiApiKey = Deno.env.get("OPENAI_API_KEY")!;

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const workerId = `sgmp-worker-${crypto.randomUUID()}`;

  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_next_ai_request",
    { input_worker_id: workerId }
  );

  if (claimError) {
    return Response.json({ ok: false, step: "claim", error: claimError.message }, { status: 500 });
  }

  if (!claimed || claimed.length === 0) {
    return Response.json({ ok: true, message: "No READY request found." });
  }

  const request = claimed[0];

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request.request_body)
    });

    const responseJson = await openaiResponse.json();

    if (!openaiResponse.ok) {
      await supabase.rpc("fail_ai_api_request", {
        input_request_id: request.api_request_id,
        input_error_message: JSON.stringify(responseJson)
      });

      return Response.json({ ok: false, step: "openai", error: responseJson }, { status: 500 });
    }

    let parsedOutput = responseJson;

    if (responseJson.output_text) {
      try {
        parsedOutput = JSON.parse(responseJson.output_text);
      } catch {
        parsedOutput = { raw_output_text: responseJson.output_text };
      }
    }

    const { error: completeError } = await supabase.rpc("complete_ai_api_request", {
      input_request_id: request.api_request_id,
      input_response_body: parsedOutput
    });

    if (completeError) {
      return Response.json({ ok: false, step: "complete", error: completeError.message }, { status: 500 });
    }

    return Response.json({
      ok: true,
      api_request_id: request.api_request_id,
      model: request.model,
      parsedOutput
    });
  } catch (error) {
    await supabase.rpc("fail_ai_api_request", {
      input_request_id: request.api_request_id,
      input_error_message: String(error)
    });

    return Response.json({ ok: false, step: "runtime", error: String(error) }, { status: 500 });
  }
});
