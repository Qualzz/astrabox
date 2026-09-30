// A Canvas face for the cabinet's TV, composited through the existing CRT.
// Only measured microphone / playback samples animate it; connection and
// server status alone must never look like someone has been heard.
export const ASTRA_PHOSPHOR = "#f4f5ac";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || 0));

export function getRobotVoicePresentation({ activity = {}, state = "idle", voiceActive = false, diagnostic = null, message = "" } = {}) {
  const microphone = activity.microphone || "off";
  const connected = Boolean(activity.connected);
  const live = voiceActive || connected || microphone === "permission";
  const input = connected && microphone === "ready" && Boolean(activity.inputActive);
  const output = connected && Boolean(activity.outputActive);
  let label = "À VOUS";
  let hint = "PARLEZ, PUIS FAITES UNE PAUSE";
  let mode = "ready";

  if (output) {
    mode = "output";
    label = "CODEX PARLE";
    hint = input ? "MICRO ACTIF" : "";
  } else if (input) {
    mode = "input";
    label = "VOUS PARLEZ";
  } else if (microphone === "permission") {
    label = "AUTORISEZ LE MICRO";
    hint = "DANS LE NAVIGATEUR";
  } else if (live && microphone === "muted") {
    label = "MICRO MUET";
    hint = "RÉACTIVEZ VOTRE MICRO";
  } else if (live && microphone === "ended") {
    label = "MICRO DÉCONNECTÉ";
    hint = "REBRANCHEZ-LE · A";
  } else if (["connecting", "reconnecting"].includes(state) || (live && !connected)) {
    label = "CONNEXION";
    hint = "UN INSTANT";
  } else if (state === "heard") {
    label = "BIEN REÇU";
    hint = "";
  } else if (state === "processing" || state === "thinking") {
    label = "UN INSTANT";
    hint = "";
  } else if (["building", "testing", "applying"].includes(state)) {
    label = { building: "CRÉATION", testing: "VÉRIFICATION", applying: "MISE À JOUR" }[state];
    hint = live ? "LE MICRO RESTE OUVERT" : "";
  } else if (!live) {
    label = "APPUYEZ SUR A";
    hint = "POUR PARLER À CODEX";
  }

  if (diagnostic) {
    const kind = `${diagnostic.code || ""} ${diagnostic.message || ""}`.toLowerCase();
    if (/permission|denied|refus|autoris/.test(kind)) {
      label = "AUTORISEZ LE MICRO";
      hint = "DANS LE NAVIGATEUR · A";
    } else if (/playback|autoplay|audio.suspended|speaker|lecture|haut.parleur|son bloqu|activer.*son/.test(kind)) {
      label = "SON BLOQUÉ";
      hint = "A · ACTIVER LE SON";
    } else if (/silenc|silent|no.?input|no.?signal/.test(kind)) {
      label = "MICRO SILENCIEUX";
      hint = "VÉRIFIEZ LE MICRO SÉLECTIONNÉ";
    } else if (/awaiting.service/.test(kind)) {
      label = "RÉPONSE EN ATTENTE";
      hint = "LE MICRO CAPTE VOTRE VOIX";
    } else if (/muted|muet/.test(kind)) {
      label = "MICRO MUET";
      hint = "RÉACTIVEZ VOTRE MICRO";
    } else if (/ended|device|not.?found|introuv|déconnect/.test(kind)) {
      label = "VÉRIFIEZ LE MICRO";
      hint = "REBRANCHEZ-LE · A";
    } else {
      label = "CONNEXION INTERROMPUE";
      hint = "A · RÉESSAYER";
    }
  } else if (["error", "disconnected"].includes(state)) {
    label = /micro|permission|notallowed/i.test(message) ? "VÉRIFIEZ LE MICRO" : "VOCAL INDISPONIBLE";
    hint = "A · RÉESSAYER";
  }

  return { mode, label, hint, input, output, live, footer: live ? "B · TERMINER" : "B · RETOUR" };
}

function drawWaveform(context, samples, x, y, width, height) {
  const values = Array.from(samples || []);
  const usable = values.length > 1;
  context.beginPath();
  context.moveTo(x, y);
  if (usable) {
    for (let index = 0; index < values.length; index += 1) {
      const progress = index / (values.length - 1);
      // An oscilloscope trace of the actual samples, with fixed gain and
      // softened ends. No sine-wave fallback when the microphone is silent.
      const envelope = Math.sin(Math.PI * progress) ** 0.45;
      const amplitude = clamp(values[index] * 2.7, -1, 1) * envelope;
      context.lineTo(x + progress * width, y + amplitude * height / 2);
    }
  }
  context.lineTo(x + width, y);
  context.lineWidth = 4;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.strokeStyle = ASTRA_PHOSPHOR;
  context.shadowColor = ASTRA_PHOSPHOR;
  context.shadowBlur = usable ? 18 : 4;
  context.stroke();
  context.shadowBlur = 0;
}

function drawSpeakingOrb(context, x, y, radius, level, elapsed, reducedMotion) {
  const strength = clamp(level, 0, 1);
  const time = reducedMotion ? 0 : elapsed;
  const baseRadius = radius * (1 + strength * 0.22);
  context.beginPath();
  for (let index = 0; index <= 128; index += 1) {
    const angle = index / 128 * Math.PI * 2;
    const ripple = (
      Math.sin(angle * 3 + time * 2.1) * 0.1
      + Math.sin(angle * 5 - time * 1.4) * 0.055
      + Math.sin(angle * 2 - time * 1.8) * 0.12
    ) * strength;
    const distance = baseRadius * (1 + ripple);
    const px = x + Math.cos(angle) * distance;
    const py = y + Math.sin(angle) * distance;
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
  const phosphor = context.createRadialGradient(x - radius * 0.22, y - radius * 0.25, radius * 0.05, x, y, baseRadius * 1.25);
  phosphor.addColorStop(0, "rgba(255,255,213,0.96)");
  phosphor.addColorStop(0.62, "rgba(246,248,174,0.88)");
  phosphor.addColorStop(1, "rgba(224,233,140,0.7)");
  context.fillStyle = phosphor;
  context.shadowColor = "rgba(242,245,160,0.65)";
  context.shadowBlur = 22 + strength * 24;
  context.fill();
  context.shadowBlur = 0;
}

export function drawRobotVoiceDisplay(context, {
  width, height, activity = {}, elapsed = 0, reducedMotion = false, ...status
}) {
  const presentation = getRobotVoicePresentation({ activity, ...status });
  const centerX = width / 2;
  const centerY = height * 0.43;
  context.save();
  context.fillStyle = "#020808";
  context.fillRect(0, 0, width, height);
  context.textAlign = "center";
  context.textBaseline = "middle";

  if (presentation.output) {
    drawSpeakingOrb(context, centerX, centerY, height * 0.15, activity.outputLevel, elapsed, reducedMotion);
    if (presentation.input) drawWaveform(context, activity.inputWaveform, width * 0.22, height * 0.66, width * 0.56, height * 0.1);
  } else if (presentation.input) {
    drawWaveform(context, activity.inputWaveform, width * 0.15, centerY, width * 0.7, height * 0.4);
  } else {
    // A stationary phosphor line means ready / quiet, never fabricated speech.
    context.globalAlpha = presentation.live ? 0.6 : 0.3;
    drawWaveform(context, [], width * 0.28, centerY, width * 0.44, 0);
    context.globalAlpha = 1;
  }

  context.fillStyle = ASTRA_PHOSPHOR;
  context.shadowColor = "rgba(243,249,168,0.6)";
  context.shadowBlur = 10;
  context.font = "600 49px monospace";
  context.fillText(presentation.label, centerX, height * 0.16, width * 0.86);
  context.font = "500 33px monospace";
  context.globalAlpha = 0.84;
  context.fillText(presentation.hint, centerX, height * 0.73, width * 0.88);
  context.font = "500 28px monospace";
  context.globalAlpha = 0.65;
  context.fillText(presentation.footer, centerX, height * 0.82, width * 0.84);
  context.restore();
  return presentation;
}
