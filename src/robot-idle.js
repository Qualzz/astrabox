// Mechanical animation is authored in the robot's resting model coordinates:
// +Z is forward, +X is right. Rotate x/travel by the platform's fixed heading
// before adding them to the world position; bodyYaw is relative to that heading.
// No per-frame integration: a skipped frame, tab suspension or a new renderer
// cannot accumulate travel or roll the robot off its platform.
export const ROBOT_WHEEL_RADIUS = .216;
const HALF_TRACK = .635;
const HALF_WHEELBASE = .395;
const TURN_RADIUS = Math.hypot(HALF_TRACK, HALF_WHEELBASE);
const TURN_STEER = Math.atan2(HALF_WHEELBASE, HALF_TRACK);
const WHEEL_SIDES = [1, -1, 1, -1]; // fl, fr, rl, rr
const TURN_STEERING = [TURN_STEER, -TURN_STEER, -TURN_STEER, TURN_STEER];
const REST_PITCH = -.2037;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const ease = (value) => value * value * value * (value * (value * 6 - 15) + 10);

// Steering happens while stopped. Drives and turns are separate, so each
// tyre's angle is its signed distance / radius, including counter-rotating
// left/right wheels on the spot. The small excursion is <= .271 model units;
// together with the chassis it fits the existing circular platform.
const choreography = [
  ["wait", 2.1], ["drive", 2.6, .18], ["wait", 2.4],
  ["steer", .65, 1], ["turn", 2.5, .56], ["wait", 1.3],
  ["steer", .65, 0], ["drive", 1.6, .10], ["wait", 1.2],
  ["drive", 1.6, -.10], ["steer", .65, 1], ["turn", 2.5, -.56],
  ["steer", .65, 0], ["wait", 2.8], ["drive", 2.6, -.18],
  ["wait", 3.6], ["steer", .65, 1], ["turn", 2.8, -.68],
  ["wait", 1.5], ["turn", 2.8, .68], ["steer", .65, 0], ["wait", 3.6],
];
export const ROBOT_IDLE_PERIOD = choreography.reduce((sum, [, duration]) => sum + duration, 0);

function compileMotion(scale) {
  let time = 0;
  let state = { x: 0, travel: 0, bodyYaw: 0, wheelSpin: [0, 0, 0, 0], wheelSteer: [0, 0, 0, 0] };
  return choreography.map(([kind, duration, amount = 0]) => {
    const from = state;
    const to = { ...from, wheelSpin: [...from.wheelSpin], wheelSteer: [...from.wheelSteer] };
    if (kind === "drive") {
      const distance = amount * scale;
      to.x += Math.sin(from.bodyYaw) * distance;
      to.travel += Math.cos(from.bodyYaw) * distance;
      to.wheelSpin = from.wheelSpin.map((spin) => spin + distance / ROBOT_WHEEL_RADIUS);
    } else if (kind === "turn") {
      const angle = amount * scale;
      to.bodyYaw += angle;
      to.wheelSpin = from.wheelSpin.map((spin, index) => spin + WHEEL_SIDES[index] * angle * TURN_RADIUS / ROBOT_WHEEL_RADIUS);
    } else if (kind === "steer") {
      to.wheelSteer = TURN_STEERING.map((angle) => angle * amount);
    }
    const segment = { start: time, end: time + duration, from, to };
    state = to;
    time += duration;
    return segment;
  });
}

// Focus/working use the same timing with smaller, physically coherent paths.
// The scene smooths mode changes rather than snapping between these poses.
const motions = { idle: compileMotion(1), working: compileMotion(.28), focused: compileMotion(.12) };

function sampleMotion(time, mode) {
  const segment = motions[mode].find(({ end }) => time < end) ?? motions[mode].at(-1);
  const mix = ease(clamp((time - segment.start) / (segment.end - segment.start), 0, 1));
  const interpolate = (a, b) => a + (b - a) * mix;
  const { from, to } = segment;
  return {
    x: interpolate(from.x, to.x), travel: interpolate(from.travel, to.travel),
    bodyYaw: interpolate(from.bodyYaw, to.bodyYaw),
    wheelSpin: from.wheelSpin.map((angle, index) => interpolate(angle, to.wheelSpin[index])),
    wheelSteer: from.wheelSteer.map((angle, index) => interpolate(angle, to.wheelSteer[index])),
  };
}

function gesture(time, start, rise, hold, fall) {
  const age = time - start;
  if (age < 0 || age >= rise + hold + fall) return 0;
  if (age < rise) return ease(age / rise);
  if (age < rise + hold) return 1;
  return 1 - ease((age - rise - hold) / fall);
}

function blinkAt(time, start) {
  const age = time - start;
  if (age < 0 || age > .21) return 0;
  return age < .075 ? ease(age / .075) : 1 - ease((age - .075) / .135);
}

export function robotIdlePose(elapsed, { focused = false, reducedMotion = false, working = false, celebrating = false } = {}) {
  if (reducedMotion) return {
    yaw: 0, pitch: REST_PITCH, roll: 0, bodyYaw: 0, x: 0, travel: 0, steer: 0,
    wheelSpin: [0, 0, 0, 0], wheelSteer: [0, 0, 0, 0],
    face: { look: 0, lookY: 0, blink: 0, curiosity: 0, smile: .18 },
  };
  const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;
  const time = ((safeElapsed % ROBOT_IDLE_PERIOD) + ROBOT_IDLE_PERIOD) % ROBOT_IDLE_PERIOD;
  const motion = sampleMotion(time, focused ? "focused" : working ? "working" : "idle");
  const left = gesture(time, .5, .85, .7, 1.1);
  const inspect = gesture(time, 4.1, .95, 1.6, 1.0);
  const curious = gesture(time, 8.6, .7, 1.5, 1.2);
  const right = gesture(time, 21.0, .9, 1.7, 1.1);
  const horizon = gesture(time, 29.2, 1.2, 1.6, 1.2);
  const amplitude = focused ? .48 : working ? .65 : 1;
  // Compensating most of the chassis turn makes it feel attentive, and keeps
  // the TV readable instead of showing the back of the head for half the loop.
  const gaze = (.25 * left - .30 * right + .16 * curious) * amplitude;
  const nod = celebrating ? Math.sin(safeElapsed * 7) * .06 : 0;
  const yaw = -motion.bodyYaw * .72 + gaze;
  // Distinct down/up looks and a two-beat nod, with real resting pauses.
  // Pitch stays readable in close-up: do not halve it with the yaw/roll scale.
  const pitchAmplitude = focused ? .85 : working ? .75 : 1;
  const acknowledge = .19 * gesture(time, 12.5, .24, .04, .38)
    + .13 * gesture(time, 13.25, .22, .04, .4)
    + .15 * gesture(time, 37.4, .38, .08, .6);
  const pitchOffset = (.28 * inspect - .24 * horizon - .13 * curious
    - .065 * left + .08 * right + acknowledge) * pitchAmplitude + nod;
  const roll = (-.055 * left + .115 * curious + .06 * right) * amplitude
    + (celebrating ? Math.sin(safeElapsed * 4.2) * .065 : 0);
  const blink = Math.max(...[1.6, 6.4, 6.76, 12.8, 18.4, 24.9, 30.7, 36.0].map((start) => blinkAt(time, start)));
  return {
    ...motion, yaw, pitch: REST_PITCH + pitchOffset, roll,
    steer: motion.wheelSteer[0],
    face: {
      look: clamp(gaze * .42, -.12, .12), lookY: clamp(pitchOffset * .55, -.08, .08), blink,
      curiosity: curious, smile: celebrating ? .95 : .18 + .3 * left + .22 * horizon,
    },
  };
}

export function findRobotRig(root) {
  return {
    yaw: root.getObjectByName("head-yaw"), pitch: root.getObjectByName("head-pitch"),
    steer: ["fl", "fr", "rl", "rr"].map((part) => root.getObjectByName(`wheel-steer-${part}`)),
    spin: ["fl", "fr", "rl", "rr"].map((part) => root.getObjectByName(`wheel-spin-${part}`)),
  };
}

export function animateRobotRig(rig, pose, blend = 1) {
  const weight = clamp(blend, 0, 1);
  const approach = (node, axis, value) => { if (node) node.rotation[axis] += (value - node.rotation[axis]) * weight; };
  approach(rig.yaw, "y", pose.yaw); approach(rig.pitch, "x", pose.pitch);
  approach(rig.pitch, "z", pose.roll ?? 0);
  rig.steer.forEach((node, index) => approach(node, "y", pose.wheelSteer?.[index] ?? pose.steer));
  rig.spin.forEach((node, index) => approach(node, "x", pose.wheelSpin?.[index] ?? pose.travel / ROBOT_WHEEL_RADIUS));
}
