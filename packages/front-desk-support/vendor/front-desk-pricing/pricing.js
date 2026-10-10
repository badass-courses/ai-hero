/*! @front-desk/pricing 0.1.0 public build; front-desk commit 4a5377470ff4a6629459560aee941ced92347674; sha256 of the body below ae07e7cda85ccffba600466c3a59450eb0df6f846639725d93e453024bc47a68 */
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Pipeable.js
var pipeArguments = (self, args) => {
	switch (args.length) {
		case 0: return self;
		case 1: return args[0](self);
		case 2: return args[1](args[0](self));
		case 3: return args[2](args[1](args[0](self)));
		case 4: return args[3](args[2](args[1](args[0](self))));
		case 5: return args[4](args[3](args[2](args[1](args[0](self)))));
		case 6: return args[5](args[4](args[3](args[2](args[1](args[0](self))))));
		case 7: return args[6](args[5](args[4](args[3](args[2](args[1](args[0](self)))))));
		case 8: return args[7](args[6](args[5](args[4](args[3](args[2](args[1](args[0](self))))))));
		case 9: return args[8](args[7](args[6](args[5](args[4](args[3](args[2](args[1](args[0](self)))))))));
		default: {
			let ret = self;
			for (let i = 0, len = args.length; i < len; i++) ret = args[i](ret);
			return ret;
		}
	}
};
var Prototype$1 = { pipe() {
	return pipeArguments(this, arguments);
} };
var Class$1 = function() {
	function PipeableBase() {}
	PipeableBase.prototype = Prototype$1;
	return PipeableBase;
}();
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Function.js
var dual = function(arity, body) {
	if (typeof arity === "function") return function() {
		return arity(arguments) ? body.apply(this, arguments) : (self) => body(self, ...arguments);
	};
	switch (arity) {
		case 0:
		case 1: throw new RangeError(`Invalid arity ${arity}`);
		case 2: return function(a, b) {
			if (arguments.length >= 2) return body(a, b);
			return function(self) {
				return body(self, a);
			};
		};
		case 3: return function(a, b, c) {
			if (arguments.length >= 3) return body(a, b, c);
			return function(self) {
				return body(self, a, b);
			};
		};
		default: return function() {
			if (arguments.length >= arity) return body.apply(this, arguments);
			const args = arguments;
			return function(self) {
				return body(self, ...args);
			};
		};
	}
};
var identity = (a) => a;
var constant = (value) => () => value;
var constTrue = constant(true);
var constUndefined = constant(void 0);
var constVoid = constUndefined;
function flow(ab, bc, cd, de, ef, fg, gh, hi, ij) {
	switch (arguments.length) {
		case 1: return ab;
		case 2: return function() {
			return bc(ab.apply(this, arguments));
		};
		case 3: return function() {
			return cd(bc(ab.apply(this, arguments)));
		};
		case 4: return function() {
			return de(cd(bc(ab.apply(this, arguments))));
		};
		case 5: return function() {
			return ef(de(cd(bc(ab.apply(this, arguments)))));
		};
		case 6: return function() {
			return fg(ef(de(cd(bc(ab.apply(this, arguments))))));
		};
		case 7: return function() {
			return gh(fg(ef(de(cd(bc(ab.apply(this, arguments)))))));
		};
		case 8: return function() {
			return hi(gh(fg(ef(de(cd(bc(ab.apply(this, arguments))))))));
		};
		case 9: return function() {
			return ij(hi(gh(fg(ef(de(cd(bc(ab.apply(this, arguments)))))))));
		};
	}
}
function memoize(f) {
	const cache = new WeakMap();
	return (a) => {
		const cached = cache.get(a);
		if (cached !== void 0) return cached;
		const result = f(a);
		cache.set(a, result);
		return result;
	};
}
function memoizeIdempotent(f) {
	const cache = new WeakMap();
	return (a) => {
		const cached = cache.get(a);
		if (cached !== void 0) return cached;
		const result = f(a);
		cache.set(a, result);
		if (result !== a) cache.set(result, result);
		return result;
	};
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/equal.js
var getAllObjectKeys = (obj) => {
	const keys = new Set(Reflect.ownKeys(obj));
	if (obj.constructor === Object) return keys;
	if (obj instanceof Error) keys.delete("stack");
	const proto = Object.getPrototypeOf(obj);
	let current = proto;
	while (current !== null && current !== Object.prototype) {
		const ownKeys = Reflect.ownKeys(current);
		for (let i = 0; i < ownKeys.length; i++) keys.add(ownKeys[i]);
		current = Object.getPrototypeOf(current);
	}
	if (keys.has("constructor") && typeof obj.constructor === "function" && proto === obj.constructor.prototype) keys.delete("constructor");
	return keys;
};
var byReferenceInstances = new WeakSet();
var viewBytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/hash.js
var backEdges = 0;
var addBackEdge = () => {
	backEdges++;
};
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Predicate.js
function isString(input) {
	return typeof input === "string";
}
function isNumber(input) {
	return typeof input === "number";
}
function isBoolean(input) {
	return typeof input === "boolean";
}
function isFunction(input) {
	return typeof input === "function";
}
function isNotNullish(input) {
	return input != null;
}
function isUnknown(_) {
	return true;
}
function isObjectKeyword(input) {
	return typeof input === "object" && input !== null || isFunction(input);
}
var hasProperty = dual(2, (self, property) => isObjectKeyword(self) && property in self);
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Hash.js
var symbol$1 = "~effect/Hash";
var hash = (self) => {
	switch (typeof self) {
		case "number": return number$1(self);
		case "bigint": return string$1(self.toString(10));
		case "string": return string$1(self);
		case "function":
		case "object": if (self === null) break;
		else if (self instanceof Date) {
			if (Number.isNaN(self.getTime())) return string$1("Invalid Date");
			return string$1(self.toISOString());
		} else if (self instanceof RegExp) return string$1(self.toString());
		else {
			if (byReferenceInstances.has(self)) return random(self);
			const cached = hashCache.get(self);
			if (cached !== void 0) return cached;
			if (visitedObjects.has(self)) {
				addBackEdge();
				return string$1("[Circular]");
			}
			visitedObjects.add(self);
			const seen = backEdges;
			let h;
			try {
				if ("~effect/Hash" in self) h = self[symbol$1]();
				else if (typeof self === "function") h = random(self);
				else if (self instanceof DataView) h = array(viewBytes(self));
				else if (Array.isArray(self) || ArrayBuffer.isView(self)) h = array(self);
				else if (self instanceof Map) h = hashMap(self);
				else if (self instanceof Set) h = hashSet(self);
				else h = structure(self);
			} finally {
				visitedObjects.delete(self);
			}
			if (seen === backEdges) hashCache.set(self, h);
			return h;
		}
	}
	return optimize(mix(string$1(String(self))));
};
var random = (self) => {
	if (!randomHashCache.has(self)) randomHashCache.set(self, optimize(Math.random() * 4294967296 | 0));
	return randomHashCache.get(self);
};
var mix = (h) => {
	h ^= h >>> 16;
	h = Math.imul(h, 2246822507);
	h ^= h >>> 13;
	h = Math.imul(h, 3266489909);
	return h ^ h >>> 16;
};
var combine = dual(2, (self, b) => mix(Math.imul(self, 2654435761) + Math.imul(b, 2246822507)));
var optimize = (n) => n & 3221225471 | n >>> 1 & 1073741824;
var float64 = new DataView(new ArrayBuffer(8));
var number$1 = (n) => {
	const h = n | 0;
	if (h === n) return optimize(h);
	float64.setFloat64(0, n !== n ? NaN : n);
	return optimize(combine(float64.getInt32(0), float64.getInt32(4)));
};
var string$1 = (str) => {
	let h = 5381, i = str.length;
	while (i) h = h * 33 ^ str.charCodeAt(--i);
	return optimize(h);
};
var structureKeys = (o, keys) => {
	let h = 12289;
	for (const key of keys) h ^= combine(hash(key), hash(o[key]));
	return optimize(h);
};
var structure = (o) => structureKeys(o, getAllObjectKeys(o));
var unordered = (seed, f) => (iter) => {
	let h = seed;
	for (const element of iter) h ^= f(element);
	return optimize(h);
};
var array = (arr) => {
	let h = 6151;
	for (const element of arr) h = combine(h, hash(element));
	return optimize(h);
};
var hashMap = unordered(string$1("Map"), ([k, v]) => combine(hash(k), hash(v)));
var setSeed = string$1("Set");
var hashSet = unordered(setSeed, (element) => combine(setSeed, hash(element)));
var randomHashCache = new WeakMap();
var hashCache = new WeakMap();
var visitedObjects = new WeakSet();
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Equal.js
var symbol = "~effect/Equal";
function equals$1() {
	if (arguments.length === 1) return (self) => compareBoth(self, arguments[0]);
	return compareBoth(arguments[0], arguments[1]);
}
function compareBoth(self, that) {
	if (self === that) return true;
	if (self == null || that == null) return false;
	const selfType = typeof self;
	if (selfType !== typeof that) return false;
	if (selfType === "number" && self !== self && that !== that) return true;
	if (selfType !== "object" && selfType !== "function") return false;
	if (byReferenceInstances.has(self) || byReferenceInstances.has(that)) return false;
	return compareObjects(self, that);
}
function compareObjects(self, that) {
	const depth = pathLeft.length;
	for (let i = depth; i-- > 0;) if (pathLeft[i] === self && pathRight[i] === that) return true;
	if (depth) return compareOnPath(self, that);
	let known = results.get(self);
	if (!known) results.set(self, known = new WeakMap());
	let result = known.get(that);
	if (result === void 0) known.set(that, result = compareOnPath(self, that));
	return result;
}
function compareOnPath(self, that) {
	pathLeft.push(self);
	pathRight.push(that);
	try {
		return compareStructure(self, that);
	} finally {
		pathLeft.pop();
		pathRight.pop();
	}
}
var pathLeft = [];
var pathRight = [];
var results = new WeakMap();
function compareStructure(self, that) {
	if (hash(self) !== hash(that)) return false;
	else if (self instanceof Date) {
		if (!(that instanceof Date)) return false;
		const selfTime = self.getTime();
		const thatTime = that.getTime();
		return selfTime === thatTime || Number.isNaN(selfTime) && Number.isNaN(thatTime);
	} else if (self instanceof RegExp) return that instanceof RegExp && self.toString() === that.toString();
	const bothEquals = isEqual(self);
	if (bothEquals !== isEqual(that) || typeof self === "function" && !bothEquals) return false;
	else if (bothEquals) return self[symbol](that);
	else if (Array.isArray(self)) {
		if (!Array.isArray(that) || self.length !== that.length) return false;
		return compareArrays(self, that);
	} else if (ArrayBuffer.isView(self)) {
		const selfIsDataView = self instanceof DataView;
		if (!ArrayBuffer.isView(that) || self.byteLength !== that.byteLength || selfIsDataView !== that instanceof DataView) return false;
		if (selfIsDataView) return compareTypedArrays(viewBytes(self), viewBytes(that));
		return compareTypedArrays(self, that);
	} else if (self instanceof Map) {
		if (!(that instanceof Map) || self.size !== that.size) return false;
		return compareHashed(self, that, entryHash, equalEntries);
	} else if (self instanceof Set) {
		if (!(that instanceof Set) || self.size !== that.size) return false;
		return compareHashed(self, that, hash, compareBoth);
	}
	return compareRecords(self, that);
}
function compareArrays(self, that) {
	for (let i = 0; i < self.length; i++) if (!compareBoth(self[i], that[i])) return false;
	return true;
}
function compareTypedArrays(self, that) {
	if (self.length !== that.length) return false;
	for (let i = 0; i < self.length; i++) if (self[i] !== that[i]) return false;
	return true;
}
function compareRecords(self, that) {
	const selfKeys = getAllObjectKeys(self);
	const thatKeys = getAllObjectKeys(that);
	if (selfKeys.size !== thatKeys.size) return false;
	for (const key of selfKeys) if (!thatKeys.has(key) || !compareBoth(self[key], that[key])) return false;
	return true;
}
function compareHashed(self, that, hashOf, equivalent) {
	const groups = new Map();
	for (const item of that) {
		const h = hashOf(item);
		const group = groups.get(h);
		if (group) group.push(item);
		else groups.set(h, [item]);
	}
	outer: for (const item of self) {
		const group = groups.get(hashOf(item));
		if (group) {
			for (let i = 0; i < group.length; i++) if (equivalent(item, group[i])) {
				group[i] = group[group.length - 1];
				group.pop();
				continue outer;
			}
		}
		return false;
	}
	return true;
}
var entryHash = (entry) => hash(entry[0]);
var equalEntries = (self, that) => compareBoth(self[0], that[0]) && compareBoth(self[1], that[1]);
var isEqual = (u) => hasProperty(u, symbol);
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Redactable.js
var symbolRedactable = Symbol.for("~effect/Redactable");
var isRedactable = (u) => hasProperty(u, symbolRedactable);
function redact(u) {
	if (isRedactable(u)) return getRedacted(u);
	return u;
}
function getRedacted(redactable) {
	return redactable[symbolRedactable](globalThis["~effect/Fiber/currentFiber"]?.context ?? emptyContext$1);
}
var currentFiberTypeId = "~effect/Fiber/currentFiber";
var emptyMap = new Map();
var emptyContext$1 = {
	"~effect/Context": {},
	base: emptyMap,
	depth: 0,
	mapUnsafe: emptyMap,
	pipe() {
		return pipeArguments(this, arguments);
	}
};
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Formatter.js
function format$1(input, options) {
	const space = options?.space ?? 0;
	const ancestors = new WeakSet();
	const gap = !space ? "" : typeof space === "number" ? " ".repeat(space) : space;
	const ind = (d) => gap.repeat(d);
	const wrap = (v, body) => {
		const ctor = v?.constructor;
		return ctor && ctor !== Object.prototype.constructor && ctor.name ? `${ctor.name}(${body})` : body;
	};
	const ownKeys = (o) => {
		try {
			return Reflect.ownKeys(o);
		} catch {
			return ["[ownKeys threw]"];
		}
	};
	function recur(v, d = 0) {
		try {
			return recurUnsafe(v, d);
		} catch {
			if (typeof v === "object" && v !== null || typeof v === "function") ancestors.delete(v);
			return "[inspection threw]";
		}
	}
	function recurUnsafe(v, d = 0) {
		if (typeof v === "string") return JSON.stringify(v);
		if (typeof v === "number" || v == null || typeof v === "boolean" || typeof v === "symbol") return String(v);
		if (typeof v === "bigint") return String(v) + "n";
		if (typeof v === "object" || typeof v === "function") {
			if (ancestors.has(v)) return CIRCULAR;
			ancestors.add(v);
			let output;
			if (symbolRedactable in v) output = recur(getRedacted(v), d);
			else if (Array.isArray(v)) output = !gap || v.length <= 1 ? `[${v.map((x) => recur(x, d)).join(",")}]` : `[\n${ind(d + 1)}${v.map((x) => recur(x, d + 1)).join(",\n" + ind(d + 1))}\n${ind(d)}]`;
			else if (v instanceof Date) output = formatDate(v);
			else if (!options?.ignoreToString && hasProperty(v, "toString") && typeof v["toString"] === "function" && v["toString"] !== Object.prototype.toString && v["toString"] !== Array.prototype.toString) {
				const s = safeToString(v);
				output = v instanceof Error && v.cause !== void 0 ? `${s} (cause: ${recur(v.cause, d)})` : s;
			} else if (Symbol.iterator in v) output = `${v.constructor.name}(${recur(Array.from(v), d)})`;
			else {
				const keys = ownKeys(v);
				if (!gap || keys.length <= 1) {
					const body = `{${keys.map((k) => `${formatPropertyKey(k)}:${recur(safeGet(v, k), d)}`).join(",")}}`;
					output = wrap(v, body);
				} else {
					const body = `{\n${keys.map((k) => `${ind(d + 1)}${formatPropertyKey(k)}: ${recur(safeGet(v, k), d + 1)}`).join(",\n")}\n${ind(d)}}`;
					output = wrap(v, body);
				}
			}
			ancestors.delete(v);
			return output;
		}
		return String(v);
	}
	return recur(input, 0);
}
var CIRCULAR = "[Circular]";
function formatPropertyKey(name) {
	return typeof name === "string" ? JSON.stringify(name) : String(name);
}
function formatPath(path) {
	return path.map((key) => `[${formatPropertyKey(key)}]`).join("");
}
function formatDate(date) {
	try {
		return date.toISOString();
	} catch {
		return "Invalid Date";
	}
}
function safeToString(input) {
	try {
		const s = input.toString();
		return typeof s === "string" ? s : String(s);
	} catch {
		return "[toString threw]";
	}
}
function safeGet(input, key) {
	try {
		return input[key];
	} catch {
		return "[property access threw]";
	}
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Inspectable.js
var NodeInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
var toJson = (input) => {
	try {
		input = redact(input);
		if (hasProperty(input, "toJSON") && isFunction(input["toJSON"]) && input["toJSON"].length === 0) return input.toJSON();
		else if (Array.isArray(input)) return input.map(toJson);
		return input;
	} catch {
		return "[toJSON threw]";
	}
};
var BaseProto = {
	toJSON() {
		return toJson(this);
	},
	[NodeInspectSymbol]() {
		return this.toJSON();
	},
	toString() {
		return format$1(this.toJSON());
	}
};
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/stackTraceLimit.js
var isStackTraceLimitWritable = () => {
	const desc = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
	if (desc === void 0) return Object.isExtensible(Error);
	return Object.hasOwn(desc, "writable") ? desc.writable === true : desc.set !== void 0;
};
var canWriteStackTraceLimit = isStackTraceLimitWritable();
var getStackTraceLimit = () => Error.stackTraceLimit;
var setStackTraceLimit = (value) => {
	if (canWriteStackTraceLimit) Error.stackTraceLimit = value;
};
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Utils.js
var SingleShotGen = class {
	constructor(self) {
		this.value = self;
		this.done = false;
	}
	next(a) {
		if (this.done) {
			this.value = a;
			return this;
		}
		this.done = true;
		return {
			value: this.value,
			done: false
		};
	}
};
var pickInternalCall = () => {
	const InternalTypeId = "~effect/Utils/internal";
	const standard = { [InternalTypeId]: (body) => {
		return body();
	} };
	const forced = { [InternalTypeId]: (body) => {
		try {
			return body();
		} finally {}
	} };
	return getStackTraceLimit() !== 0 && standard[InternalTypeId](() => new Error().stack)?.includes(InternalTypeId) === true ? standard[InternalTypeId] : forced[InternalTypeId];
};
var internalCall = pickInternalCall();
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/record.js
function assignProperty(self, key, value) {
	if (key === "__proto__") Object.defineProperty(self, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
	else self[key] = value;
}
function assignProperties(self, source) {
	for (const key of Reflect.ownKeys(source)) if (Object.prototype.propertyIsEnumerable.call(source, key)) assignProperty(self, key, source[key]);
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/core.js
var EffectTypeId = `~effect/Effect`;
var ExitTypeId = `~effect/Exit`;
var effectVariance = {
	_A: identity,
	_E: identity,
	_R: identity
};
var identifier = `${EffectTypeId}/identifier`;
var args = `${EffectTypeId}/args`;
var evaluate = `${EffectTypeId}/evaluate`;
var contA = `${EffectTypeId}/successCont`;
var contE = `${EffectTypeId}/failureCont`;
var contAll = `${EffectTypeId}/ensureCont`;
var Yield = Symbol.for("effect/Effect/Yield");
var PipeInspectableProto = {
	pipe() {
		return pipeArguments(this, arguments);
	},
	toJSON() {
		return { ...this };
	},
	toString() {
		return format$1(this.toJSON(), {
			ignoreToString: true,
			space: 2
		});
	},
	[NodeInspectSymbol]() {
		return this.toJSON();
	}
};
var EffectProto = {
	[EffectTypeId]: effectVariance,
	...PipeInspectableProto,
	[Symbol.iterator]() {
		return new SingleShotGen(this);
	},
	toJSON() {
		return {
			_id: "Effect",
			op: this[identifier],
			...args in this ? { args: this[args] } : void 0
		};
	}
};
var isExit = (u) => hasProperty(u, ExitTypeId);
var CauseTypeId = "~effect/Cause";
var CauseReasonTypeId = "~effect/Cause/Reason";
var isCause = (self) => hasProperty(self, CauseTypeId);
var CauseImpl = class {
	constructor(failures) {
		this[CauseTypeId] = CauseTypeId;
		this.reasons = failures;
	}
	pipe() {
		return pipeArguments(this, arguments);
	}
	toJSON() {
		return {
			_id: "Cause",
			failures: this.reasons.map((f) => f.toJSON())
		};
	}
	toString() {
		return `Cause(${format$1(this.reasons)})`;
	}
	[NodeInspectSymbol]() {
		return this.toJSON();
	}
	[symbol](that) {
		return isCause(that) && this.reasons.length === that.reasons.length && this.reasons.every((e, i) => equals$1(e, that.reasons[i]));
	}
	[symbol$1]() {
		return array(this.reasons);
	}
};
var annotationsMap = new WeakMap();
var ReasonBase = class {
	[CauseReasonTypeId];
	annotations;
	_tag;
	constructor(_tag, annotations, originalError) {
		this[CauseReasonTypeId] = CauseReasonTypeId;
		this._tag = _tag;
		if (annotations !== constEmptyAnnotations && typeof originalError === "object" && originalError !== null && annotations.size > 0) {
			const prevAnnotations = annotationsMap.get(originalError);
			if (prevAnnotations) annotations = new Map([...prevAnnotations, ...annotations]);
			annotationsMap.set(originalError, annotations);
		}
		this.annotations = annotations;
	}
	annotate(annotations, options) {
		if (annotations.mapUnsafe.size === 0) return this;
		const newAnnotations = new Map(this.annotations);
		annotations.mapUnsafe.forEach((value, key) => {
			if (options?.overwrite !== true && newAnnotations.has(key)) return;
			newAnnotations.set(key, value);
		});
		const self = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
		self.annotations = newAnnotations;
		return self;
	}
	pipe() {
		return pipeArguments(this, arguments);
	}
	toString() {
		return format$1(this);
	}
	[NodeInspectSymbol]() {
		return this.toString();
	}
};
var constEmptyAnnotations = new Map();
var Fail = class extends ReasonBase {
	constructor(error, annotations = constEmptyAnnotations) {
		super("Fail", annotations, error);
		this.error = error;
	}
	toString() {
		return `Fail(${format$1(this.error)})`;
	}
	toJSON() {
		return {
			_tag: "Fail",
			error: this.error
		};
	}
	[symbol](that) {
		return isFailReason$1(that) && equals$1(this.error, that.error) && equals$1(this.annotations, that.annotations);
	}
	[symbol$1]() {
		return combine(string$1(this._tag))(combine(hash(this.error))(hash(this.annotations)));
	}
};
var causeFromReasons = (reasons) => new CauseImpl(reasons);
var dedupeReasons = (self, that) => {
	const buckets = new Map();
	const out = [];
	for (const reason of self.concat(that)) {
		const hash$2 = hash(reason);
		const bucket = buckets.get(hash$2);
		if (bucket === void 0) buckets.set(hash$2, [reason]);
		else if (bucket.some((previous) => equals$1(previous, reason))) continue;
		else bucket.push(reason);
		out.push(reason);
	}
	return out;
};
var causeCombine = dual(2, (self, that) => {
	if (self.reasons.length === 0) return that;
	else if (that.reasons.length === 0) return self;
	const newCause = new CauseImpl(dedupeReasons(self.reasons, that.reasons));
	return equals$1(self, newCause) ? self : newCause;
});
var causeFail = (error) => new CauseImpl([new Fail(error)]);
var Die = class extends ReasonBase {
	constructor(defect, annotations = constEmptyAnnotations) {
		super("Die", annotations, defect);
		this.defect = defect;
	}
	toString() {
		return `Die(${format$1(this.defect)})`;
	}
	toJSON() {
		return {
			_tag: "Die",
			defect: this.defect
		};
	}
	[symbol](that) {
		return isDieReason(that) && equals$1(this.defect, that.defect) && equals$1(this.annotations, that.annotations);
	}
	[symbol$1]() {
		return combine(string$1(this._tag))(combine(hash(this.defect))(hash(this.annotations)));
	}
};
var causeDie = (defect) => new CauseImpl([new Die(defect)]);
var causeAnnotate = dual((args) => isCause(args[0]), (self, annotations, options) => {
	if (annotations.mapUnsafe.size === 0) return self;
	return new CauseImpl(self.reasons.map((f) => f.annotate(annotations, options)));
});
var isFailReason$1 = (self) => self._tag === "Fail";
var isDieReason = (self) => self._tag === "Die";
var isInterruptReason = (self) => self._tag === "Interrupt";
function defaultEvaluate(_fiber) {
	return exitDie(`Effect.evaluate: Not implemented`);
}
var makePrimitiveProto = (options) => ({
	...EffectProto,
	[identifier]: options.op,
	[evaluate]: options[evaluate] ?? defaultEvaluate,
	[contA]: options[contA],
	[contE]: options[contE],
	[contAll]: options[contAll]
});
var makePrimitive = (options) => {
	const Proto = makePrimitiveProto(options);
	const PrimitiveImpl = function(value) {
		this[args] = value;
	};
	PrimitiveImpl.prototype = Proto;
	return function(value) {
		return new PrimitiveImpl(value);
	};
};
var makeExit = (options) => {
	const Proto = {
		[ExitTypeId]: ExitTypeId,
		_tag: options.op,
		get [options.prop]() {
			return this[args];
		},
		...makePrimitiveProto(options),
		toString() {
			return `${options.op}(${format$1(this[args])})`;
		},
		toJSON() {
			return {
				_id: "Exit",
				_tag: options.op,
				[options.prop]: this[args]
			};
		},
		[symbol](that) {
			return isExit(that) && that._tag === this._tag && equals$1(this[args], that[args]);
		},
		[symbol$1]() {
			return combine(string$1(options.op), hash(this[args]));
		}
	};
	const ExitPrimitive = function(value) {
		this[args] = value;
	};
	ExitPrimitive.prototype = Proto;
	return function(value) {
		return new ExitPrimitive(value);
	};
};
var exitSucceed = makeExit({
	op: "Success",
	prop: "value",
	[evaluate](fiber) {
		const cont = fiber.getCont(contA);
		return cont ? cont[contA](this[args], fiber, this) : fiber.yieldWith(this);
	}
});
var StackTraceKey = { key: "effect/Cause/StackTrace" };
var InterruptorStackTrace = { key: "effect/Cause/InterruptorStackTrace" };
var exitFailCause = makeExit({
	op: "Failure",
	prop: "cause",
	[evaluate](fiber) {
		let cause = this[args];
		let annotated = false;
		if (fiber.cache.stackFrame) {
			cause = causeAnnotate(cause, { mapUnsafe: new Map([[StackTraceKey.key, fiber.cache.stackFrame]]) });
			annotated = true;
		}
		let cont = fiber.getCont(contE);
		const interruptedCause = fiber._interruptedCause;
		if (interruptedCause && fiber.interruptible) {
			let skippedHandler = false;
			while (cont && fiber.interruptible) {
				skippedHandler ||= identifier in cont;
				cont = fiber.getCont(contE);
			}
			if (skippedHandler) cause = causeFromReasons(cause.reasons.filter((reason) => reason._tag !== "Fail"));
			cause = causeCombine(cause, interruptedCause);
			annotated = true;
		}
		return cont ? cont[contE](cause, fiber, annotated ? void 0 : this) : fiber.yieldWith(annotated ? exitFailCause(cause) : this);
	}
});
var exitFail = (e) => exitFailCause(causeFail(e));
var exitDie = (defect) => exitFailCause(causeDie(defect));
var withFiber = makePrimitive({
	op: "WithFiber",
	[evaluate](fiber) {
		return this[args](fiber);
	}
});
var YieldableError = function() {
	class YieldableError extends globalThis.Error {}
	const proto = makePrimitiveProto({
		op: "YieldableError",
		[evaluate]() {
			return exitFail(this);
		}
	});
	delete proto.toString;
	Object.assign(YieldableError.prototype, proto);
	return YieldableError;
}();
var Error$2 = function() {
	const plainArgsSymbol = Symbol.for("effect/Data/Error/plainArgs");
	return class Base extends YieldableError {
		constructor(args) {
			super(args?.message, args?.cause ? { cause: args.cause } : void 0);
			if (args) {
				assignProperties(this, args);
				Object.defineProperty(this, plainArgsSymbol, {
					value: args,
					enumerable: false
				});
			}
		}
		toJSON() {
			return {
				...this[plainArgsSymbol],
				...this
			};
		}
	};
}();
var TaggedError$1 = (tag) => {
	class Base extends Error$2 {
		_tag = tag;
	}
	Base.prototype.name = tag;
	return Base;
};
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Effectable.js
var Prototype = (options) => makePrimitiveProto({
	op: options.label,
	[evaluate]: options.evaluate
});
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/option.js
var TypeId$11 = "~effect/Option";
var CommonProto$1 = {
	[TypeId$11]: { _A: (_) => _ },
	...PipeInspectableProto,
	[Symbol.iterator]() {
		return new SingleShotGen(this);
	}
};
var SomeProto = Object.defineProperty(Object.assign(Object.create(CommonProto$1), {
	_tag: "Some",
	_op: "Some",
	[symbol](that) {
		return isOption(that) && isSome$1(that) && equals$1(this.value, that.value);
	},
	[symbol$1]() {
		return combine(hash(this._tag))(hash(this.value));
	},
	toString() {
		return `some(${format$1(this.value)})`;
	},
	toJSON() {
		return {
			_id: "Option",
			_tag: this._tag,
			value: toJson(this.value)
		};
	}
}), "valueOrUndefined", { get() {
	return this.value;
} });
var NoneHash = hash("None");
var NoneProto = Object.assign(Object.create(CommonProto$1), {
	_tag: "None",
	_op: "None",
	valueOrUndefined: void 0,
	[symbol](that) {
		return isOption(that) && isNone$1(that);
	},
	[symbol$1]() {
		return NoneHash;
	},
	toString() {
		return `none()`;
	},
	toJSON() {
		return {
			_id: "Option",
			_tag: this._tag
		};
	}
});
var isOption = (input) => hasProperty(input, TypeId$11);
var isNone$1 = (fa) => fa._tag === "None";
var isSome$1 = (fa) => fa._tag === "Some";
var none$1 = Object.create(NoneProto);
var SomeImpl = function(value) {
	this.value = value;
};
SomeImpl.prototype = SomeProto;
var some$1 = (value) => new SomeImpl(value);
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/result.js
var TypeId$10 = "~effect/Result";
var CommonProto = {
	[TypeId$10]: {
		_A: (_) => _,
		_E: (_) => _
	},
	...PipeInspectableProto,
	[Symbol.iterator]() {
		return new SingleShotGen(this);
	}
};
var SuccessProto = Object.assign(Object.create(CommonProto), {
	_tag: "Success",
	_op: "Success",
	[symbol](that) {
		return isResult(that) && isSuccess$2(that) && equals$1(this.success, that.success);
	},
	[symbol$1]() {
		return combine(hash(this._tag))(hash(this.success));
	},
	toString() {
		return `success(${format$1(this.success)})`;
	},
	toJSON() {
		return {
			_id: "Result",
			_tag: this._tag,
			value: toJson(this.success)
		};
	}
});
var FailureProto = Object.assign(Object.create(CommonProto), {
	_tag: "Failure",
	_op: "Failure",
	[symbol](that) {
		return isResult(that) && isFailure$1(that) && equals$1(this.failure, that.failure);
	},
	[symbol$1]() {
		return combine(hash(this._tag))(hash(this.failure));
	},
	toString() {
		return `failure(${format$1(this.failure)})`;
	},
	toJSON() {
		return {
			_id: "Result",
			_tag: this._tag,
			failure: toJson(this.failure)
		};
	}
});
var isResult = (input) => hasProperty(input, TypeId$10);
var isFailure$1 = (result) => result._tag === "Failure";
var isSuccess$2 = (result) => result._tag === "Success";
var FailureImpl = function(failure) {
	this.failure = failure;
};
FailureImpl.prototype = FailureProto;
var fail$5 = (failure) => new FailureImpl(failure);
var SuccessImpl = function(success) {
	this.success = success;
};
SuccessImpl.prototype = SuccessProto;
var succeed$5 = (success) => new SuccessImpl(success);
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Order.js
function make$9(compare) {
	return (self, that) => self === that ? 0 : compare(self, that);
}
var String$4 = make$9((self, that) => self < that ? -1 : 1);
var Number$4 = make$9((self, that) => {
	if (globalThis.Number.isNaN(self) && globalThis.Number.isNaN(that)) return 0;
	if (globalThis.Number.isNaN(self)) return -1;
	if (globalThis.Number.isNaN(that)) return 1;
	return self < that ? -1 : 1;
});
var isLessThan$1 = (O) => dual(2, (self, that) => O(self, that) === -1);
var isGreaterThan$1 = (O) => dual(2, (self, that) => O(self, that) === 1);
var isLessThanOrEqualTo$1 = (O) => dual(2, (self, that) => O(self, that) !== 1);
var isGreaterThanOrEqualTo$1 = (O) => dual(2, (self, that) => O(self, that) !== -1);
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Option.js
var none = () => none$1;
var some = some$1;
var isNone = isNone$1;
var isSome = isSome$1;
var match$2 = dual(2, (self, { onNone, onSome }) => isNone(self) ? onNone() : onSome(self.value));
var liftThrowable = (f) => (...a) => {
	try {
		return some(f(...a));
	} catch {
		return none();
	}
};
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Context.js
var ServiceTypeId = "~effect/Context/Service";
var Service = function() {
	function KeyClass() {}
	const self = KeyClass;
	Object.setPrototypeOf(self, ServiceProto);
	const init = (key, options) => {
		self.key = key;
		if (options?.defaultValue) {
			self[ReferenceTypeId] = ReferenceTypeId;
			self.defaultValue = options.defaultValue;
		}
		if (options?.make) self.make = options.make;
		if (options?.fiberCached) cacheKeys.add(key);
		return self;
	};
	return arguments.length > 0 ? init(arguments[0], arguments[1]) : init;
};
var ServiceProto = {
	[ServiceTypeId]: ServiceTypeId,
	...Prototype({
		label: "Service",
		evaluate(fiber) {
			return exitSucceed(get(fiber.context, this));
		}
	}),
	toJSON() {
		return {
			_id: "Service",
			key: this.key
		};
	},
	of(self) {
		return self;
	},
	context(self) {
		return make$8(this, self);
	},
	use(f) {
		return withFiber((fiber) => f(get(fiber.context, this)));
	},
	useSync(f) {
		return withFiber((fiber) => exitSucceed(f(get(fiber.context, this))));
	}
};
var cacheKeys = new Set();
var ReferenceTypeId = "~effect/Context/Reference";
var TypeId$9 = "~effect/Context";
var MaxDepth = 8;
var FlattenAfterBaseHits = 8;
var makeImpl = (cacheRoot, base, overlay, depth) => {
	const self = Object.create(Proto$3);
	self.cacheRoot = cacheRoot ?? self;
	self.base = base;
	self.overlay = overlay;
	self.depth = depth;
	self._flat = void 0;
	self.baseHits = 0;
	return self;
};
var applyOverlays = (map, overlay) => {
	if (!overlay) return;
	applyOverlays(map, overlay.parent);
	map.set(overlay.key, overlay.value);
};
var flatten = (self) => {
	if (self._flat) return self._flat;
	if (!self.overlay) return self._flat = self.base;
	const map = new Map(self.base);
	applyOverlays(map, self.overlay);
	return self._flat = map;
};
var notFound = Symbol();
var lookup = (self, key) => {
	const impl = self;
	for (let overlay = impl.overlay; overlay; overlay = overlay.parent) if (overlay.key === key) return overlay.value;
	const value = impl.base.get(key);
	if (value === void 0 && !impl.base.has(key)) return notFound;
	if (impl.overlay && ++impl.baseHits >= impl.base.size && impl.baseHits >= FlattenAfterBaseHits) {
		impl.base = flatten(impl);
		impl.overlay = void 0;
		impl.depth = 0;
	}
	return value;
};
var makeUnsafe$2 = (mapUnsafe) => makeImpl(void 0, mapUnsafe, void 0, 0);
var Proto$3 = {
	get mapUnsafe() {
		return flatten(this);
	},
	...PipeInspectableProto,
	[TypeId$9]: { _Services: (_) => _ },
	toJSON() {
		return {
			_id: "Context",
			services: Array.from(this.mapUnsafe).map(([key, value]) => ({
				key,
				value
			}))
		};
	},
	[symbol](that) {
		if (!isContext(that)) return false;
		const self = this.mapUnsafe;
		const other = that.mapUnsafe;
		if (self.size !== other.size) return false;
		for (const [key, value] of self) if (!other.has(key) || !equals$1(value, other.get(key))) return false;
		return true;
	},
	[symbol$1]() {
		return number$1(this.mapUnsafe.size);
	}
};
var hasSameCache = (self, that) => self.cacheRoot === that.cacheRoot;
var isContext = (u) => hasProperty(u, TypeId$9);
var isReference = (u) => !!u[ReferenceTypeId];
var empty$1 = () => emptyContext;
var emptyContext = makeUnsafe$2(new Map());
var make$8 = (key, service) => makeUnsafe$2(new Map([[key.key, service]]));
var add = dual(3, (self, key, service) => addUnsafe(self, key.key, service));
var addUnsafe = (self, key, service) => {
	const impl = self;
	const cacheRoot = cacheKeys.has(key) ? void 0 : impl.cacheRoot;
	if (impl.depth >= MaxDepth) {
		const map = new Map(impl.mapUnsafe);
		map.set(key, service);
		return makeImpl(cacheRoot, map, void 0, 0);
	}
	return makeImpl(cacheRoot, impl.base, {
		key,
		value: service,
		parent: impl.overlay
	}, impl.depth + 1);
};
var getOrUndefinedUnsafe = (self, key) => {
	const value = lookup(self, key);
	return value === notFound ? void 0 : value;
};
var get = dual(2, (self, service) => {
	const value = lookup(self, service.key);
	if (value === notFound) {
		if (isReference(service)) return getDefaultValue(service);
		throw serviceNotFoundError(service);
	}
	return value;
});
var defaultValueCacheKey = "~effect/Context/defaultValue";
var getDefaultValue = (ref) => {
	if (defaultValueCacheKey in ref) return ref[defaultValueCacheKey];
	return ref[defaultValueCacheKey] = ref.defaultValue();
};
var serviceNotFoundError = (service) => {
	const error = new Error(`Service not found${service.key ? `: ${String(service.key)}` : ""}`);
	if (error.stack) {
		const lines = error.stack.split("\n");
		lines.splice(1, 3);
		error.stack = lines.join("\n");
	}
	return error;
};
var Reference = Service;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/array.js
var isArrayNonEmpty$1 = (self) => self.length > 0;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Result.js
var succeed$4 = succeed$5;
var fail$4 = fail$5;
var isFailure = isFailure$1;
var match$1 = dual(2, (self, { onFailure, onSuccess }) => isFailure(self) ? onFailure(self.failure) : onSuccess(self.success));
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Array.js
var Array$1 = globalThis.Array;
var append = dual(2, (self, last) => [...self, last]);
Array$1.isArray;
var isArrayNonEmpty = isArrayNonEmpty$1;
var isReadonlyArrayNonEmpty = isArrayNonEmpty$1;
var empty = () => [];
var map$2 = dual(2, (self, f) => self.map(f));
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Duration.js
var TypeId$8 = "~effect/Duration";
var bigint0$1 = BigInt(0);
var bigint1$1 = BigInt(1);
var bigint2 = BigInt(2);
var bigint10$1 = BigInt(10);
var bigint1e3 = BigInt(1e3);
var roundTiesAwayFromZero = (input) => BigInt(input < 0 ? Math.ceil(input - .5) : Math.floor(input + .5));
var roundMillisToNanos = (millis) => roundTiesAwayFromZero(millis * 1e6);
var parseNanos = (input, scale) => {
	const decimalIndex = input.indexOf(".");
	if (decimalIndex === -1) return BigInt(input) * scale;
	const isNegative = input[0] === "-";
	const fractional = input.slice(decimalIndex + 1);
	const fractionalScale = bigint10$1 ** BigInt(fractional.length);
	const scaled = (BigInt(input.slice(isNegative ? 1 : 0, decimalIndex)) * fractionalScale + BigInt(fractional)) * scale;
	const rounded = scaled / fractionalScale + (scaled % fractionalScale * bigint2 >= fractionalScale ? bigint1$1 : bigint0$1);
	return isNegative ? -rounded : rounded;
};
var DURATION_REGEXP = /^(-?\d+(?:\.\d+)?)\s+(nanos?|micros?|millis?|seconds?|minutes?|hours?|days?|weeks?)$/;
var fromInputUnsafe = (input) => {
	switch (typeof input) {
		case "number": return millis(input);
		case "bigint": return nanos(input);
		case "string": {
			if (input === "Infinity") return infinity;
			if (input === "-Infinity") return negativeInfinity;
			const match = DURATION_REGEXP.exec(input);
			if (!match) break;
			const [_, valueStr, unit] = match;
			if (unit === "nano" || unit === "nanos") return nanos(parseNanos(valueStr, bigint1$1));
			if (unit === "micro" || unit === "micros") return nanos(parseNanos(valueStr, bigint1e3));
			const value = Number(valueStr);
			switch (unit) {
				case "milli":
				case "millis": return millis(value);
				case "second":
				case "seconds": return seconds(value);
				case "minute":
				case "minutes": return minutes(value);
				case "hour":
				case "hours": return hours(value);
				case "day":
				case "days": return days(value);
				case "week":
				case "weeks": return weeks(value);
			}
			break;
		}
		case "object": {
			if (input === null) break;
			if (TypeId$8 in input) return input;
			if (Array.isArray(input)) {
				if (input.length !== 2 || !input.every(isNumber)) return invalid$1(input);
				if (Number.isNaN(input[0]) || Number.isNaN(input[1])) return zero$1;
				if (input[0] === -Infinity || input[1] === -Infinity) return negativeInfinity;
				if (input[0] === Infinity || input[1] === Infinity) return infinity;
				return make$7(roundTiesAwayFromZero(input[0] * 1e9 + input[1]));
			}
			const obj = input;
			let millis = 0;
			if (obj.weeks) millis += obj.weeks * 6048e5;
			if (obj.days) millis += obj.days * 864e5;
			if (obj.hours) millis += obj.hours * 36e5;
			if (obj.minutes) millis += obj.minutes * 6e4;
			if (obj.seconds) millis += obj.seconds * 1e3;
			if (obj.milliseconds) millis += obj.milliseconds;
			if (!obj.microseconds && !obj.nanoseconds) return make$7(millis);
			return make$7(roundTiesAwayFromZero(millis * 1e6 + (obj.microseconds ?? 0) * 1e3 + (obj.nanoseconds ?? 0)));
		}
	}
	return invalid$1(input);
};
var invalid$1 = (input) => {
	throw new Error(`Invalid Input: ${input}`);
};
var zeroDurationValue = {
	_tag: "Millis",
	millis: 0
};
var infinityDurationValue = { _tag: "Infinity" };
var negativeInfinityDurationValue = { _tag: "NegativeInfinity" };
var DurationProto = {
	[TypeId$8]: TypeId$8,
	[symbol$1]() {
		switch (this.value._tag) {
			case "Millis": {
				const nanos = this.value.millis * 1e6;
				return Number.isFinite(nanos) ? hash(roundTiesAwayFromZero(nanos)) : number$1(this.value.millis);
			}
			case "Nanos": return hash(this.value.nanos);
			default: return structure(this.value);
		}
	},
	[symbol](that) {
		return isDuration(that) && equals(this, that);
	},
	toString() {
		switch (this.value._tag) {
			case "Infinity": return "Infinity";
			case "NegativeInfinity": return "-Infinity";
			case "Nanos": return `${this.value.nanos} nanos`;
			case "Millis": return `${this.value.millis} millis`;
		}
	},
	toJSON() {
		switch (this.value._tag) {
			case "Millis": return {
				_id: "Duration",
				_tag: "Millis",
				millis: this.value.millis
			};
			case "Nanos": return {
				_id: "Duration",
				_tag: "Nanos",
				nanos: String(this.value.nanos)
			};
			case "Infinity": return {
				_id: "Duration",
				_tag: "Infinity"
			};
			case "NegativeInfinity": return {
				_id: "Duration",
				_tag: "NegativeInfinity"
			};
		}
	},
	[NodeInspectSymbol]() {
		return this.toJSON();
	},
	pipe() {
		return pipeArguments(this, arguments);
	}
};
var make$7 = (input) => {
	const duration = Object.create(DurationProto);
	if (typeof input === "number") {
		if (isNaN(input) || input === 0 || Object.is(input, -0)) duration.value = zeroDurationValue;
		else if (!Number.isFinite(input)) duration.value = input > 0 ? infinityDurationValue : negativeInfinityDurationValue;
		else if (!Number.isInteger(input)) duration.value = {
			_tag: "Nanos",
			nanos: roundMillisToNanos(input)
		};
		else duration.value = {
			_tag: "Millis",
			millis: input
		};
	} else if (input === bigint0$1) duration.value = zeroDurationValue;
	else duration.value = {
		_tag: "Nanos",
		nanos: input
	};
	return duration;
};
var isDuration = (u) => hasProperty(u, TypeId$8);
var zero$1 = make$7(0);
var infinity = make$7(Infinity);
var negativeInfinity = make$7(-Infinity);
var nanos = (nanos) => make$7(nanos);
var millis = (millis) => make$7(millis);
var seconds = (seconds) => make$7(seconds * 1e3);
var minutes = (minutes) => make$7(minutes * 6e4);
var hours = (hours) => make$7(hours * 36e5);
var days = (days) => make$7(days * 864e5);
var weeks = (weeks) => make$7(weeks * 6048e5);
var toNanosUnsafe = (input) => {
	const self = fromInputUnsafe(input);
	switch (self.value._tag) {
		case "Infinity":
		case "NegativeInfinity": throw new Error("Cannot convert infinite duration to nanos");
		case "Nanos": return self.value.nanos;
		case "Millis": return roundMillisToNanos(self.value.millis);
	}
};
var matchPair = dual(3, (self, that, options) => {
	if (self.value._tag === "Infinity" || self.value._tag === "NegativeInfinity" || that.value._tag === "Infinity" || that.value._tag === "NegativeInfinity") return options.onInfinity(self, that);
	if (self.value._tag === "Millis") return that.value._tag === "Millis" ? options.onMillis(self.value.millis, that.value.millis) : options.onNanos(toNanosUnsafe(self), that.value.nanos);
	else return options.onNanos(self.value.nanos, toNanosUnsafe(that));
});
var Equivalence$1 = (self, that) => matchPair(self, that, {
	onMillis: (self, that) => self === that,
	onNanos: (self, that) => self === that,
	onInfinity: (self, that) => self.value._tag === that.value._tag
});
var equals = dual(2, (self, that) => Equivalence$1(self, that));
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Scheduler.js
var Scheduler = Reference("effect/Scheduler", {
	fiberCached: true,
	defaultValue: () => new MixedScheduler()
});
var setMicrotask = (f) => {
	let cancelled = false;
	Promise.resolve().then(() => {
		if (!cancelled) f();
	});
	return () => {
		cancelled = true;
	};
};
var setTimer = "setImmediate" in globalThis ? (f) => {
	const timer = globalThis.setImmediate(f);
	return () => globalThis.clearImmediate(timer);
} : (f) => {
	const timer = setTimeout(f, 0);
	return () => clearTimeout(timer);
};
var setImmediate = (f) => {
	try {
		return setTimer(f);
	} catch {
		return setMicrotask(f);
	}
};
var PriorityBuckets = class {
	buckets = [];
	scheduleTask(task, priority) {
		const buckets = this.buckets;
		const len = buckets.length;
		let bucket;
		let index = 0;
		for (; index < len; index++) {
			if (buckets[index][0] > priority) break;
			bucket = buckets[index];
		}
		if (bucket && bucket[0] === priority) bucket[1].push(task);
		else if (index === len) buckets.push([priority, [task]]);
		else buckets.splice(index, 0, [priority, [task]]);
	}
	drain() {
		const buckets = this.buckets;
		this.buckets = [];
		return buckets;
	}
};
var MixedScheduler = class {
	executionMode;
	setImmediate;
	constructor(executionMode = "async", setImmediateFn) {
		this.executionMode = executionMode;
		this.setImmediate = setImmediateFn ?? (executionMode === "sync" ? setMicrotask : setImmediate);
	}
	shouldYield(fiber) {
		return fiber.currentOpCount >= fiber.cache.maxOpsBeforeYield;
	}
	makeDispatcher() {
		return new MixedSchedulerDispatcher(this.setImmediate);
	}
};
var MixedSchedulerDispatcher = class {
	tasks = new PriorityBuckets();
	running = void 0;
	setImmediate;
	constructor(setImmediateFn = setImmediate) {
		this.setImmediate = setImmediateFn;
	}
	scheduleTask(task, priority) {
		this.tasks.scheduleTask(task, priority);
		if (this.running === void 0) this.running = this.setImmediate(this.afterScheduled);
	}
	afterScheduled = () => {
		this.running = void 0;
		this.runTasks();
	};
	runTasks() {
		const buckets = this.tasks.drain();
		for (let i = 0; i < buckets.length; i++) {
			const toRun = buckets[i][1];
			for (let j = 0; j < toRun.length; j++) toRun[j]();
		}
	}
	flush() {
		while (this.tasks.buckets.length > 0) {
			if (this.running !== void 0) {
				this.running();
				this.running = void 0;
			}
			this.runTasks();
		}
	}
};
var MaxOpsBeforeYield = Reference("effect/Scheduler/MaxOpsBeforeYield", {
	fiberCached: true,
	defaultValue: () => 2048
});
var PreventSchedulerYield = Reference("effect/Scheduler/PreventSchedulerYield", {
	fiberCached: true,
	defaultValue: () => false
});
var TaggedError = TaggedError$1;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Tracer.js
var ParentSpanKey = "effect/Tracer/ParentSpan";
var TracerKey = "effect/Tracer";
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/metric.js
var FiberRuntimeMetricsKey = "effect/Metric/FiberRuntimeMetrics";
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/references.js
var CurrentStackFrame = Reference("effect/References/CurrentStackFrame", {
	fiberCached: true,
	defaultValue: constUndefined
});
var TracerEnabled = Reference("effect/References/TracerEnabled", {
	fiberCached: true,
	defaultValue: constTrue
});
var CurrentLogLevel = Reference("effect/References/CurrentLogLevel", {
	fiberCached: true,
	defaultValue: () => "Info"
});
var MinimumLogLevel = Reference("effect/References/MinimumLogLevel", {
	fiberCached: true,
	defaultValue: () => "Info"
});
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/effect.js
var Interrupt = class extends ReasonBase {
	constructor(fiberId, annotations = constEmptyAnnotations) {
		super("Interrupt", annotations, "Interrupted");
		this.fiberId = fiberId;
	}
	toString() {
		return `Interrupt(${this.fiberId})`;
	}
	toJSON() {
		return {
			_tag: "Interrupt",
			fiberId: this.fiberId
		};
	}
	[symbol](that) {
		return isInterruptReason(that) && this.fiberId === that.fiberId && this.annotations === that.annotations;
	}
	[symbol$1]() {
		return combine(string$1(`${this._tag}:${this.fiberId}`))(random(this.annotations));
	}
};
var causeInterrupt = (fiberId) => new CauseImpl([new Interrupt(fiberId)]);
var hasInterrupts = (self) => self.reasons.some(isInterruptReason);
var causeMap = dual(2, (self, f) => {
	let hasFail = false;
	const failures = self.reasons.map((failure) => {
		if (isFailReason$1(failure)) {
			hasFail = true;
			return new Fail(f(failure.error), failure.annotations);
		}
		return failure;
	});
	return hasFail ? causeFromReasons(failures) : self;
});
var FiberTypeId = "~effect/Fiber";
var fiberVariance = {
	_A: identity,
	_E: identity
};
var fiberIdStore = { id: 0 };
var AsyncResource = (() => {
	try {
		return globalThis.process?.getBuiltinModule?.("node:async_hooks")?.AsyncResource;
	} catch {
		return;
	}
})();
var captureAsyncContext = () => AsyncResource === void 0 ? void 0 : new AsyncResource("effect/Fiber");
var getCurrentFiber = () => globalThis[currentFiberTypeId];
var FiberImpl = class {
	constructor(context, interruptible = true) {
		this.setContext(context);
		this.id = ++fiberIdStore.id;
		this.currentOpCount = 0;
		this.interruptible = interruptible;
		this._stack = [];
		this._observers = void 0;
		this._exit = void 0;
		this._children = void 0;
		this._interruptedCause = void 0;
		this._yielded = void 0;
		this._running = false;
		this._deferredInterrupt = false;
		this._parent = void 0;
		this._asyncContext = void 0;
		this.cache.runtimeMetrics?.recordFiberStart(this.context);
	}
	get [FiberTypeId]() {
		return fiberVariance;
	}
	get currentDispatcher() {
		return this._dispatcher ??= this.cache.scheduler.makeDispatcher();
	}
	getRef(ref) {
		return get(this.context, ref);
	}
	addObserver(cb) {
		if (this._exit) {
			cb(this._exit);
			return constVoid;
		}
		if (this._observers === void 0) this._observers = [cb];
		else this._observers.push(cb);
		return () => this.removeObserver(cb);
	}
	removeObserver(cb) {
		if (this._exit || this._observers === void 0) return;
		const index = this._observers.indexOf(cb);
		if (index >= 0) this._observers.splice(index, 1);
	}
	interruptUnsafe(fiberId, annotations) {
		if (this._exit) return;
		let cause = causeInterrupt(fiberId);
		if (this.cache.stackFrame) cause = causeAnnotate(cause, make$8(StackTraceKey, this.cache.stackFrame));
		if (annotations) cause = causeAnnotate(cause, annotations);
		this._interruptedCause = this._interruptedCause ? causeCombine(this._interruptedCause, cause) : cause;
		if (this.interruptible) {
			if (this._running) this._deferredInterrupt = true;
			else this.evaluate(failCause$1(this._interruptedCause));
		}
	}
	pollUnsafe() {
		return this._exit;
	}
	evaluate(effect) {
		if (this._exit) return;
		else if (this._asyncContext !== void 0) {
			const asyncContext = this._asyncContext;
			this._asyncContext = void 0;
			return asyncContext.runInAsyncScope(this.evaluate, this, effect);
		} else if (this._yielded !== void 0) {
			const yielded = this._yielded;
			this._yielded = void 0;
			yielded();
		}
		const exit = this.runLoop(effect);
		if (exit === Yield) {
			this._asyncContext = captureAsyncContext();
			return;
		}
		const interruptChildren = fiberMiddleware.interruptChildren && fiberMiddleware.interruptChildren(this);
		if (interruptChildren !== void 0) return this.evaluate(flatMap$1(interruptChildren, () => exit));
		this._exit = exit;
		this.cache.runtimeMetrics?.recordFiberEnd(this.context, this._exit);
		if (this._parent) {
			this._parent._children?.delete(this);
			this._parent = void 0;
		}
		if (this._observers !== void 0) {
			const observers = this._observers;
			this._observers = void 0;
			for (let i = 0; i < observers.length; i++) observers[i](exit);
		}
		this._stack.length = 0;
		this._children = void 0;
		this.context = empty$1();
	}
	runLoop(effect) {
		const prevFiber = globalThis[currentFiberTypeId];
		globalThis[currentFiberTypeId] = this;
		const prevRunning = this._running;
		this._running = true;
		let yielding = false;
		let current = effect;
		this.currentOpCount = 0;
		try {
			while (true) {
				if (this._deferredInterrupt) {
					this._deferredInterrupt = false;
					current = failCause$1(this._interruptedCause);
				}
				this.currentOpCount++;
				const cache = this.cache;
				if (!yielding && !cache.preventYield && cache.scheduler.shouldYield(this)) {
					yielding = true;
					const prev = current;
					current = flatMap$1(yieldNow, () => prev);
				}
				current = cache.tracerContext ? cache.tracerContext(current, this) : current[evaluate](this);
				if (current === Yield) {
					const yielded = this._yielded;
					if (ExitTypeId in yielded) {
						this._deferredInterrupt = false;
						this._yielded = void 0;
						return yielded;
					} else if (this._deferredInterrupt) {
						this._yielded = void 0;
						yielded();
						continue;
					}
					return Yield;
				}
			}
		} catch (error) {
			if (!hasProperty(current, evaluate)) return exitDie(`Fiber.runLoop: Not a valid effect: ${String(current)}`);
			return this.runLoop(exitDie(error));
		} finally {
			this._running = prevRunning;
			globalThis[currentFiberTypeId] = prevFiber;
		}
	}
	getCont(symbol) {
		if (this._deferredInterrupt) {
			this._deferredInterrupt = false;
			return deferredInterruptCont;
		}
		while (true) {
			const op = this._stack.pop();
			if (!op) return void 0;
			const all = op[contAll];
			if (all !== void 0) {
				const cont = all.call(op, this);
				if (cont) {
					cont[symbol] = cont;
					return cont;
				}
			}
			if (op[symbol]) return op;
		}
	}
	succeedWith(value) {
		if ((++this.currentOpCount & maxInlineSteps - 1) === 0) return exitSucceed(value);
		const cont = this.getCont(contA);
		return cont ? cont[contA](value, this) : this.yieldWith(exitSucceed(value));
	}
	yieldWith(value) {
		this._yielded = value;
		return Yield;
	}
	children() {
		return this._children ??= new Set();
	}
	pipe() {
		return pipeArguments(this, arguments);
	}
	setContext(context) {
		const previous = this.context;
		this.context = context;
		if (previous !== void 0 && hasSameCache(previous, context)) return;
		const root = context.cacheRoot;
		const cache = root._fiberCache ??= makeFiberContextCache(context);
		if (this.cache?.scheduler !== cache.scheduler) this._dispatcher = void 0;
		this.cache = cache;
	}
	get currentSpanLocal() {
		const span = this.cache.span;
		return span?._tag === "Span" ? span : void 0;
	}
};
var makeFiberContextCache = (context) => {
	const currentTracer = getOrUndefinedUnsafe(context, TracerKey);
	return {
		scheduler: get(context, Scheduler),
		tracer: currentTracer,
		tracerContext: currentTracer ? currentTracer["context"] : void 0,
		tracerEnabled: get(context, TracerEnabled),
		span: getOrUndefinedUnsafe(context, ParentSpanKey),
		logLevel: get(context, CurrentLogLevel),
		minimumLogLevel: get(context, MinimumLogLevel),
		stackFrame: get(context, CurrentStackFrame),
		runtimeMetrics: getOrUndefinedUnsafe(context, FiberRuntimeMetricsKey),
		maxOpsBeforeYield: get(context, MaxOpsBeforeYield),
		preventYield: get(context, PreventSchedulerYield)
	};
};
var deferredInterruptCont = {
	[contA](_value, fiber) {
		return failCause$1(fiber._interruptedCause);
	},
	[contE](_cause, fiber) {
		return failCause$1(fiber._interruptedCause);
	}
};
var maxInlineSteps = 32;
var fiberMiddleware = { interruptChildren: void 0 };
var fiberStackAnnotations = (fiber) => {
	if (!fiber.cache.stackFrame) return void 0;
	const annotations = new Map();
	annotations.set(InterruptorStackTrace.key, fiber.cache.stackFrame);
	return makeUnsafe$2(annotations);
};
var fiberAwaitAll = (self) => callback((resume) => {
	const iter = self[Symbol.iterator]();
	const exits = [];
	let cancel = void 0;
	function loop() {
		let result = iter.next();
		while (!result.done) {
			if (result.value._exit) {
				exits.push(result.value._exit);
				result = iter.next();
				continue;
			}
			cancel = result.value.addObserver((exit) => {
				exits.push(exit);
				loop();
			});
			return;
		}
		resume(succeed$3(exits));
	}
	loop();
	return sync(() => cancel?.());
});
var fiberInterruptAll = (fibers) => withFiber((parent) => {
	const annotations = fiberStackAnnotations(parent);
	let fiberArr = empty();
	for (const fiber of fibers) {
		fiber.interruptUnsafe(parent.id, annotations);
		fiberArr.push(fiber);
	}
	return asVoid(fiberAwaitAll(fiberArr));
});
var succeed$3 = exitSucceed;
var failCause$1 = exitFailCause;
var fail$3 = exitFail;
var sync = makePrimitive({
	op: "Sync",
	[evaluate](fiber) {
		const value = this[args]();
		const cont = fiber.getCont(contA);
		return cont ? cont[contA](value, fiber) : fiber.yieldWith(exitSucceed(value));
	}
});
var suspend$1 = makePrimitive({
	op: "Suspend",
	[evaluate](_fiber) {
		return this[args]();
	}
});
var yieldNow = makePrimitive({
	op: "Yield",
	[evaluate](fiber) {
		let resumed = false;
		fiber.currentDispatcher.scheduleTask(() => {
			if (resumed) return;
			fiber.evaluate(exitVoid);
		}, this[args] ?? 0);
		return fiber.yieldWith(() => {
			resumed = true;
		});
	}
})(0);
var failCauseSync$1 = (evaluate) => suspend$1(() => failCause$1(evaluate()));
var die$2 = (defect) => exitDie(defect);
var void_$1 = succeed$3(void 0);
var callbackOptions = function() {
	const Proto = makePrimitiveProto({
		op: "Async",
		[evaluate](fiber) {
			let resumed = false;
			let yielded = false;
			const controller = this.withSignal ? new AbortController() : void 0;
			const onCancel = this.register.call(fiber.cache.scheduler, (effect) => {
				if (resumed) return;
				resumed = true;
				if (yielded) fiber.evaluate(effect);
				else yielded = effect;
			}, controller?.signal);
			if (yielded !== false) return yielded;
			yielded = true;
			fiber._yielded = () => {
				resumed = true;
			};
			if (controller === void 0 && onCancel === void 0) return Yield;
			fiber._stack.push(asyncFinalizer(() => {
				resumed = true;
				controller?.abort();
				return onCancel ?? exitVoid;
			}));
			return Yield;
		}
	});
	const AsyncImpl = function(register, withSignal) {
		this.register = register;
		this.withSignal = withSignal;
	};
	AsyncImpl.prototype = Proto;
	return function(register, withSignal) {
		return new AsyncImpl(register, withSignal);
	};
}();
var asyncFinalizer = makePrimitive({
	op: "AsyncFinalizer",
	[contAll](fiber) {
		if (fiber.interruptible) {
			fiber.interruptible = false;
			fiber._stack.push(setInterruptibleTrue);
		}
	},
	[contE](cause, _fiber) {
		return hasInterrupts(cause) ? flatMap$1(combineFinalizerCause(exitFailCause(cause), this[args]()), () => failCause$1(cause)) : failCause$1(cause);
	}
});
var callback = (register) => callbackOptions(register, register.length >= 2);
var defineFunctionLength = (length, fn) => Object.defineProperty(fn, "length", {
	value: length,
	configurable: true
});
var fnUntracedEager$1 = (body, ...pipeables) => defineFunctionLength(body.length, pipeables.length === 0 ? function() {
	return fromIteratorEagerUnsafe(() => body.apply(this, arguments));
} : function() {
	let effect = fromIteratorEagerUnsafe(() => body.apply(this, arguments));
	for (const pipeable of pipeables) effect = pipeable(effect, ...arguments);
	return effect;
});
var fromIteratorEagerUnsafe = (evaluate) => {
	try {
		const iterator = evaluate();
		let value = void 0;
		while (true) {
			const state = iterator.next(value);
			if (state.done) return succeed$3(state.value);
			const primitive = state.value;
			if (primitive && primitive._tag === "Success") {
				value = primitive.value;
				continue;
			} else if (primitive && primitive._tag === "Failure") return state.value;
			else {
				let isFirstExecution = true;
				return suspend$1(() => {
					if (isFirstExecution) {
						isFirstExecution = false;
						return flatMap$1(state.value, (value) => fromIteratorUnsafe(iterator, value));
					} else return suspend$1(() => fromIteratorUnsafe(evaluate()));
				});
			}
		}
	} catch (error) {
		return die$2(error);
	}
};
var fromIteratorUnsafe = function() {
	const Proto = makePrimitiveProto({
		op: "Iterator",
		[contA](value, fiber) {
			const iter = this.iterator;
			while (true) {
				const state = iter.next(value);
				if (state.done) return succeed$3(state.value);
				if (!effectIsExit(state.value)) {
					fiber._stack.push(this);
					return state.value;
				} else if (state.value._tag === "Failure") return state.value;
				value = state.value.value;
			}
		},
		[evaluate](fiber) {
			return this[contA](this.initial, fiber);
		}
	});
	const IteratorImpl = function(iterator, initial) {
		this.iterator = iterator;
		this.initial = initial;
	};
	IteratorImpl.prototype = Proto;
	return function(iterator, initial) {
		return new IteratorImpl(iterator, initial);
	};
}();
var evaluateCont = function(fiber) {
	fiber._stack.push(this);
	return this[args];
};
var OnSuccessProto = makePrimitiveProto({
	op: "OnSuccess",
	[evaluate]: evaluateCont
});
var ContImpl = function(self, cont, payload) {
	this[args] = self;
	this[contA] = cont;
	this.payload = payload;
};
ContImpl.prototype = OnSuccessProto;
var returnPayload = function() {
	return this.payload;
};
var continuationMarksStack = (() => {
	const marker = "~effect/Effect/stackProbe";
	return { [marker]: function stackProbe() {
		return new Error().stack;
	} }[marker]()?.includes("[as " + marker + "]") === true;
})();
var mapCont = function(value, fiber) {
	const f = this.payload;
	return fiber.succeedWith(continuationMarksStack ? f(value) : internalCall(() => f(value)));
};
var andThenCont = function(value) {
	const f = this.payload;
	return f(value);
};
var asVoid = (self) => new ContImpl(self, returnPayload, exitVoid);
var flatMap$1 = dual(2, (self, f) => new ContImpl(self, andThenCont, f));
var effectIsExit = (effect) => effect[ExitTypeId] !== void 0;
var flatMapEager$1 = dual(2, (self, f) => {
	if (effectIsExit(self)) return self._tag === "Success" ? f(self.value) : self;
	return flatMap$1(self, f);
});
var map$1 = dual(2, (self, f) => new ContImpl(self, mapCont, f));
var mapEager$1 = dual(2, (self, f) => effectIsExit(self) ? exitMap(self, f) : map$1(self, f));
var exitIsSuccess = (self) => self._tag === "Success";
var exitVoid = exitSucceed(void 0);
var exitMap = dual(2, (self, f) => self._tag === "Success" ? exitSucceed(f(self.value)) : self);
var catchCause$1 = dual(2, (self, f) => new OnFailureImpl(self, f.length !== 1 ? (cause) => f(cause) : f));
var OnFailureProto = makePrimitiveProto({
	op: "OnFailure",
	[evaluate]: evaluateCont
});
var OnFailureImpl = function(self, f) {
	this[args] = self;
	this[contE] = f;
};
OnFailureImpl.prototype = OnFailureProto;
var OnSuccessAndFailureProto = makePrimitiveProto({
	op: "OnSuccessAndFailure",
	[evaluate]: evaluateCont
});
var OnSuccessAndFailureImpl = function(self, onSuccess, onFailure) {
	this[args] = self;
	this[contA] = onSuccess;
	this[contE] = onFailure;
};
OnSuccessAndFailureImpl.prototype = OnSuccessAndFailureProto;
var exit$1 = (self) => effectIsExit(self) ? exitSucceed(self) : exitPrimitive(self);
var exitPrimitive = makePrimitive({
	op: "Exit",
	[evaluate](fiber) {
		fiber._stack.push(this);
		return this[args];
	},
	[contA](value, fiber, exit) {
		return fiber.succeedWith(exit ?? exitSucceed(value));
	},
	[contE](cause, fiber, exit) {
		return fiber.succeedWith(exit ?? exitFailCause(cause));
	}
});
var combineFinalizerCause = (exit_, finalizer) => exitIsSuccess(exit_) ? finalizer : catchCause$1(finalizer, (cause) => failCause$1(causeCombine(exit_.cause, cause)));
var uninterruptible = (self) => withFiber((fiber) => {
	if (!fiber.interruptible) return self;
	fiber.interruptible = false;
	fiber._stack.push(setInterruptibleTrue);
	return self;
});
var setInterruptibleTrue = makePrimitive({
	op: "SetInterruptible",
	[contAll](fiber) {
		fiber.interruptible = this[args];
		if (fiber._interruptedCause && fiber.interruptible) return () => failCause$1(fiber._interruptedCause);
	}
})(true);
var resolveConcurrency = (concurrency) => concurrency === "unbounded" ? Number.POSITIVE_INFINITY : Math.max(1, concurrency ?? 1);
var iterateEager = () => (options) => {
	const onItem = options.onItem;
	const step = options.step;
	const resumeSequential = (state, items, index, end, effect) => flatMap$1(exit$1(effect), (itemExit) => step(state, items[index], itemExit, index) ?? runSequential(state, items, index + 1, end) ?? void_$1);
	const runSequential = (state, items, index = 0, end = items.length) => {
		for (; index < end; index++) {
			const item = items[index];
			const effect = onItem(state, item, index);
			if (!effectIsExit(effect)) return resumeSequential(state, items, index, end, effect);
			const terminal = step(state, item, effect, index);
			if (terminal) return terminal._tag === "Failure" ? terminal : void 0;
		}
	};
	return runSequential;
};
var iterateConcurrentImpl = (options) => {
	const onItem = options.onItem;
	const step = options.step;
	return (state, items, opts) => {
		let index = 0;
		const end = opts.end ?? items.length;
		const concurrency = opts.concurrency;
		let done = false;
		let parentFiber;
		let fibers;
		let resume;
		let terminal;
		let effect;
		const failDefect = (error) => {
			const defect = exitDie(error);
			terminal = defect;
			done = true;
			return fibers && fibers.size > 0 ? flatMap$1(uninterruptible(fiberInterruptAll(Array.from(fibers))), () => terminal ?? defect) : defect;
		};
		const go = () => {
			let paused = false;
			for (; !terminal && index < end; index++) {
				const item = items[index];
				const eff = effect ?? onItem(state, item, index);
				if (effectIsExit(eff)) {
					terminal = step(state, item, eff, index);
					if (terminal) break;
				} else if (!parentFiber) return callback((cb) => {
					parentFiber = getCurrentFiber();
					fibers = new Set();
					effect = eff;
					resume = cb;
					let result;
					try {
						result = go();
					} catch (error) {
						return cb(failDefect(error));
					}
					if (result) return cb(result);
					return suspend$1(() => {
						terminal ??= exitVoid;
						return flatMap$1(fibers ? fiberInterruptAll(fibers) : void_$1, () => terminal?._tag === "Failure" ? terminal : void_$1);
					});
				});
				else {
					effect = void 0;
					const fiber = forkUnsafe(parentFiber, eff, true, true, "inherit");
					if (fiber._exit) {
						terminal = step(state, item, fiber._exit, index);
						if (terminal) break;
						continue;
					}
					fibers.add(fiber);
					const currentIndex = index;
					fiber.addObserver((exit) => {
						fibers.delete(fiber);
						try {
							if (terminal) {
								if (exit._tag === "Failure") {
									const reasons = exit.cause.reasons.filter((reason) => reason._tag !== "Interrupt");
									if (reasons.length > 0) {
										const cause = causeFromReasons(reasons);
										terminal = exitFailCause(terminal._tag === "Failure" ? causeCombine(terminal.cause, cause) : cause);
									}
								}
							} else {
								const result = step(state, item, exit, currentIndex);
								if (result) {
									terminal = result;
									go();
								}
							}
							if (paused) {
								const eff = go();
								if (eff) resume(eff);
							} else if (done && fibers.size === 0) resume(terminal ?? void_$1);
						} catch (error) {
							resume(failDefect(error));
						}
					});
					if (fibers.size < concurrency) continue;
					paused = true;
					index++;
					return;
				}
			}
			done = true;
			if (terminal) {
				if (fibers && fibers.size > 0) {
					const annotations = fiberStackAnnotations(parentFiber);
					fibers.forEach((f) => f.interruptUnsafe(parentFiber.id, annotations));
					return;
				}
				if (resume || terminal._tag === "Failure") return terminal;
			} else if (resume) {
				if (!fibers) return exitVoid;
				else if (fibers.size === 0) resume(void_$1);
			}
		};
		return go();
	};
};
var iterateConcurrent = () => (options) => iterateConcurrentImpl(options);
var forkUnsafe = (parent, effect, immediate = false, daemon = false, uninterruptible = false) => {
	const parentRuntime = parent;
	const interruptible = uninterruptible === "inherit" ? parentRuntime.interruptible : !uninterruptible;
	const child = new FiberImpl(parentRuntime.context, interruptible);
	if (immediate) child.evaluate(effect);
	else {
		child._asyncContext = captureAsyncContext();
		parentRuntime.currentDispatcher.scheduleTask(() => child.evaluate(effect), 0);
	}
	if (!daemon && !child._exit) {
		parentRuntime.children().add(child);
		child._parent = parentRuntime;
	}
	return child;
};
var runForkWith = (context) => (effect, options) => {
	const fiber = new FiberImpl(options?.scheduler ? add(context, Scheduler, options.scheduler) : context, options?.uninterruptible !== true);
	fiber.evaluate(effect);
	if (fiber._exit) return fiber;
	if (options?.signal) {
		if (options.signal.aborted) fiber.interruptUnsafe();
		else {
			const abort = () => fiber.interruptUnsafe();
			options.signal.addEventListener("abort", abort, { once: true });
			fiber.addObserver(() => options.signal.removeEventListener("abort", abort));
		}
	}
	if (options?.onFiberStart) options.onFiberStart(fiber);
	return fiber;
};
var runSyncExitWith = (context) => {
	const runFork = runForkWith(context);
	return (effect) => {
		if (effectIsExit(effect)) return effect;
		const scheduler = new MixedScheduler("sync");
		const fiber = runFork(effect, { scheduler });
		fiber._dispatcher?.flush();
		return fiber._exit ?? exitDie(new AsyncFiberError(fiber));
	};
};
var runSyncExit$1 = runSyncExitWith(empty$1());
var IllegalArgumentErrorTypeId = "~effect/Cause/IllegalArgumentError";
var IllegalArgumentError$1 = class extends TaggedError$1("IllegalArgumentError") {
	[IllegalArgumentErrorTypeId] = IllegalArgumentErrorTypeId;
	constructor(message) {
		super({ message });
	}
};
var AsyncFiberErrorTypeId = "~effect/Cause/AsyncFiberError";
var AsyncFiberError = class extends TaggedError$1("AsyncFiberError") {
	[AsyncFiberErrorTypeId] = AsyncFiberErrorTypeId;
	constructor(fiber) {
		super({
			message: "An asynchronous Effect was executed with Effect.runSync",
			fiber
		});
	}
};
var colors = {
	bold: "1",
	red: "31",
	green: "32",
	yellow: "33",
	blue: "34",
	cyan: "36",
	white: "37",
	gray: "90",
	black: "30",
	bgBrightRed: "101"
};
colors.gray, colors.blue, colors.green, colors.yellow, colors.red, colors.bgBrightRed, colors.black;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Cause.js
var isFailReason = isFailReason$1;
var die$1 = causeDie;
var map = causeMap;
var IllegalArgumentError = IllegalArgumentError$1;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Exit.js
var succeed$2 = exitSucceed;
var failCause = exitFailCause;
var fail$2 = exitFail;
var void_ = exitVoid;
var isSuccess = exitIsSuccess;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/dateTime.js
var TypeId$7 = "~effect/DateTime";
var TimeZoneTypeId = "~effect/DateTime/TimeZone";
var Proto$2 = {
	[TypeId$7]: TypeId$7,
	pipe() {
		return pipeArguments(this, arguments);
	},
	[NodeInspectSymbol]() {
		return this.toString();
	},
	toJSON() {
		return toDateUtc$1(this).toJSON();
	}
};
var ProtoUtc = {
	...Proto$2,
	_tag: "Utc",
	[symbol$1]() {
		return number$1(this.epochMilliseconds);
	},
	[symbol](that) {
		return isDateTime$1(that) && that._tag === "Utc" && this.epochMilliseconds === that.epochMilliseconds;
	},
	toString() {
		return `DateTime.Utc(${toDateUtc$1(this).toJSON()})`;
	}
};
({ ...Proto$2 });
var ProtoTimeZone = {
	[TimeZoneTypeId]: TimeZoneTypeId,
	[NodeInspectSymbol]() {
		return this.toString();
	}
};
({ ...ProtoTimeZone });
({ ...ProtoTimeZone });
var isDateTime$1 = (u) => hasProperty(u, TypeId$7);
var isUtc$1 = (self) => self._tag === "Utc";
var makeUtc = (epochMillis) => {
	const self = Object.create(ProtoUtc);
	self.epochMilliseconds = epochMillis;
	Object.defineProperty(self, "partsUtc", {
		value: void 0,
		enumerable: false,
		writable: true
	});
	return self;
};
var fromDateUnsafe = (date) => {
	const epochMillis = date.getTime();
	if (Number.isNaN(epochMillis)) throw new IllegalArgumentError("Invalid date");
	return makeUtc(epochMillis);
};
var makeUnsafe$1 = (input) => {
	if (isDateTime$1(input)) return input;
	else if (input instanceof Date) return fromDateUnsafe(input);
	else if (typeof input === "object") {
		if ("epochMilliseconds" in input) return fromDateUnsafe(new Date(input.epochMilliseconds));
		const date = new Date(0);
		setPartsDate(date, input);
		return fromDateUnsafe(date);
	} else if (typeof input === "string" && !hasZone(input)) return fromDateUnsafe(new Date(input + "Z"));
	return fromDateUnsafe(new Date(input));
};
var hasZone = (input) => /Z|GMT|[+-]\d{2}$|[+-]\d{2}:?\d{2}$|\]$/.test(input);
var make$6 = liftThrowable(makeUnsafe$1);
var toUtc$1 = (self) => makeUtc(self.epochMilliseconds);
var toDateUtc$1 = (self) => new Date(self.epochMilliseconds);
var toEpochMillis$1 = (self) => self.epochMilliseconds;
var setPartsDate = (date, parts) => {
	if (parts.year !== void 0 || parts.month !== void 0 || parts.day !== void 0) date.setUTCFullYear(parts.year ?? date.getUTCFullYear(), parts.month !== void 0 ? parts.month - 1 : date.getUTCMonth(), parts.day ?? date.getUTCDate());
	if (parts.weekDay !== void 0) {
		const diff = parts.weekDay - date.getUTCDay();
		date.setUTCDate(date.getUTCDate() + diff);
	}
	if (parts.hour !== void 0) date.setUTCHours(parts.hour);
	if (parts.minute !== void 0) date.setUTCMinutes(parts.minute);
	if (parts.second !== void 0) date.setUTCSeconds(parts.second);
	if (parts.millisecond !== void 0) date.setUTCMilliseconds(parts.millisecond);
};
var formatIso$1 = (self) => toDateUtc$1(self).toISOString();
var succeed$1 = succeed$3;
var suspend = suspend$1;
var fail$1 = fail$3;
var failCauseSync = failCauseSync$1;
var die = die$2;
var flatMap = flatMap$1;
var exit = exit$1;
var catchCause = catchCause$1;
var runSyncExit = runSyncExit$1;
var mapEager = mapEager$1;
var flatMapEager = flatMapEager$1;
var fnUntracedEager = fnUntracedEager$1;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/BigDecimal.js
var TypeId$6 = "~effect/BigDecimal";
var BigDecimalProto = {
	[TypeId$6]: TypeId$6,
	[symbol$1]() {
		const normalized = normalize(this);
		return combine(string$1(String(normalized.value)), number$1(normalized.scale));
	},
	[symbol](that) {
		return isBigDecimal(that) && compare(this, that) === 0;
	},
	toString() {
		return `BigDecimal(${format(this)})`;
	},
	toJSON() {
		return {
			_id: "BigDecimal",
			value: String(this.value),
			scale: this.scale
		};
	},
	[NodeInspectSymbol]() {
		return this.toJSON();
	},
	pipe() {
		return pipeArguments(this, arguments);
	}
};
var isBigDecimal = (u) => hasProperty(u, TypeId$6);
var make$5 = (value, scale) => {
	if (!Number.isSafeInteger(scale)) throw new RangeError(`Scale must be a safe integer, got ${scale}`);
	const o = Object.create(BigDecimalProto);
	o.value = value;
	o.scale = scale;
	return o;
};
var makeNormalized = (value, scale) => {
	const o = make$5(value, scale);
	o.normalized = o;
	return o;
};
var bigint0 = BigInt(0);
var bigint1 = BigInt(1);
var bigint10 = BigInt(10);
var zero = makeNormalized(bigint0, 0);
var normalize = (self) => {
	if (self.normalized === void 0) {
		if (self.value === bigint0) self.normalized = zero;
		else {
			const digits = `${self.value}`;
			let end = digits.length;
			while (digits[end - 1] === "0") end--;
			self.normalized = makeNormalized(BigInt(digits.slice(0, end)), self.scale - (digits.length - end));
		}
	}
	return self.normalized;
};
var MAX_COMPARISON_SCALE_ALIGNMENT = 100;
var comparisonPowersOfTen = [bigint1];
var compareBigInt = (self, that) => self === that ? 0 : self < that ? -1 : 1;
var compareMagnitude = (self, that) => {
	const selfDigits = `${self.value < bigint0 ? -self.value : self.value}`;
	const thatDigits = `${that.value < bigint0 ? -that.value : that.value}`;
	const exponentDifference = BigInt(selfDigits.length - thatDigits.length) - BigInt(self.scale) + BigInt(that.scale);
	if (exponentDifference !== bigint0) return exponentDifference < bigint0 ? -1 : 1;
	const length = Math.max(selfDigits.length, thatDigits.length);
	return String$4(selfDigits.padEnd(length, "0"), thatDigits.padEnd(length, "0"));
};
var compare = (self, that) => {
	if (self.scale === that.scale) return compareBigInt(self.value, that.value);
	const selfSign = sign(self);
	const thatSign = sign(that);
	if (selfSign !== thatSign) return selfSign < thatSign ? -1 : 1;
	if (selfSign === 0) return 0;
	const scaleDifference = self.scale - that.scale;
	const absoluteScaleDifference = Math.abs(scaleDifference);
	if (absoluteScaleDifference > MAX_COMPARISON_SCALE_ALIGNMENT) return selfSign === -1 ? compareMagnitude(that, self) : compareMagnitude(self, that);
	const powerOfTen = comparisonPowersOfTen[absoluteScaleDifference] ??= bigint10 ** BigInt(absoluteScaleDifference);
	return scaleDifference > 0 ? compareBigInt(self.value, that.value * powerOfTen) : compareBigInt(self.value * powerOfTen, that.value);
};
var sign = (n) => n.value === bigint0 ? 0 : n.value < bigint0 ? -1 : 1;
var format = (n) => {
	const normalized = normalize(n);
	if (Math.abs(normalized.scale) >= 16) return toExponential(normalized);
	const negative = normalized.value < bigint0;
	const absolute = `${negative ? -normalized.value : normalized.value}`;
	const digits = normalized.scale > 0 ? absolute.padStart(normalized.scale + 1, "0") : absolute.padEnd(absolute.length - normalized.scale, "0");
	const point = digits.length - normalized.scale;
	const complete = normalized.scale > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits;
	return negative ? `-${complete}` : complete;
};
var toExponential = (n) => {
	if (isZero(n)) return "0e+0";
	const normalized = normalize(n);
	const digits = `${normalized.value}`;
	const point = normalized.value < bigint0 ? 2 : 1;
	const head = digits.slice(0, point);
	const tail = digits.slice(point);
	const exp = tail.length - normalized.scale;
	return `${head}${tail === "" ? "" : `.${tail}`}e${exp >= 0 ? "+" : ""}${exp}`;
};
var isZero = (n) => n.value === bigint0;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/DateTime.js
var isDateTime = isDateTime$1;
var isUtc = isUtc$1;
var makeUnsafe = makeUnsafe$1;
var make$4 = make$6;
var toUtc = toUtc$1;
var toEpochMillis = toEpochMillis$1;
var formatIso = formatIso$1;
var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var codes = new Uint8Array(123).fill(255);
for (let i = 0; i < 64; i++) codes[alphabet.charCodeAt(i)] = i;
codes["=".charCodeAt(0)] = 0;
({ ...BaseProto });
({ ...BaseProto });
({ ...PipeInspectableProto });
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/schema/annotations.js
function resolve$1(ast) {
	return ast.checks ? ast.checks[ast.checks.length - 1].annotations : ast.annotations;
}
var STRUCTURAL_ANNOTATION_KEY = "~structural";
var SENTINELS_ANNOTATION_KEY = "~sentinels";
var CONSTRUCTOR_ANNOTATION_KEY = "~constructor";
var getExpected = memoize((ast) => {
	const identifier = resolve$1(ast)?.identifier;
	if (typeof identifier === "string") return identifier;
	return ast.getExpected(getExpected);
});
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/schema/parser.js
var missing = Symbol();
var succeed = succeed$2;
var missingExit = succeed(missing);
var sameExit = succeed(missing);
var toOption = (value) => value === missing ? none() : some(value);
var fromOptionExit = (option) => option._tag === "None" ? missingExit : succeed(option.value);
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/SchemaIssue.js
var TypeId$3 = "~effect/SchemaIssue/Issue";
function isIssue(u) {
	return hasProperty(u, TypeId$3) && u[TypeId$3] === TypeId$3;
}
function hasInput(issue) {
	return Object.hasOwn(issue, "input");
}
var IssueNodeImpl = class {
	[TypeId$3] = TypeId$3;
	constructor(input, options) {
		if (options?.reportInput === true && input !== missing) this.input = input;
	}
};
var Filter$1 = class extends IssueNodeImpl {
	_tag = "Filter";
	filter;
	issue;
	constructor(filter, issue, input, options) {
		super(input, options);
		this.filter = filter;
		this.issue = issue;
	}
};
var Encoding = class extends IssueNodeImpl {
	_tag = "Encoding";
	ast;
	issue;
	constructor(ast, issue, input, options) {
		super(input, options);
		this.ast = ast;
		this.issue = issue;
	}
};
var Pointer = class extends IssueNodeImpl {
	_tag = "Pointer";
	path;
	issue;
	constructor(path, issue) {
		super();
		this.path = path;
		this.issue = issue;
	}
};
var MissingKey = class extends IssueNodeImpl {
	_tag = "MissingKey";
	annotations;
	constructor(annotations) {
		super();
		this.annotations = annotations;
	}
};
var UnexpectedKey = class extends IssueNodeImpl {
	_tag = "UnexpectedKey";
	ast;
	constructor(ast, input, options) {
		super(input, options);
		this.ast = ast;
	}
};
var Composite = class extends IssueNodeImpl {
	_tag = "Composite";
	ast;
	issues;
	constructor(ast, issues, input, options) {
		super(input, options);
		this.ast = ast;
		this.issues = issues;
	}
};
var InvalidType = class extends IssueNodeImpl {
	_tag = "InvalidType";
	ast;
	constructor(ast, input, options) {
		super(input, options);
		this.ast = ast;
	}
};
var InvalidValue = class extends IssueNodeImpl {
	_tag = "InvalidValue";
	annotations;
	constructor(annotations, input, options) {
		super(input, options);
		this.annotations = annotations;
	}
};
var Forbidden = class extends IssueNodeImpl {
	_tag = "Forbidden";
	annotations;
	constructor(annotations, input, options) {
		super(input, options);
		this.annotations = annotations;
	}
};
var AnyOf = class extends IssueNodeImpl {
	_tag = "AnyOf";
	ast;
	issues;
	constructor(ast, issues, input, options) {
		super(input, options);
		this.ast = ast;
		this.issues = issues;
	}
};
var OneOf = class extends IssueNodeImpl {
	_tag = "OneOf";
	ast;
	successes;
	constructor(ast, successes, input, options) {
		super(input, options);
		this.ast = ast;
		this.successes = successes;
	}
};
function makeFilterIssue(entry, input, options) {
	if (isIssue(entry)) return entry;
	if (typeof entry === "string") return new InvalidValue({ message: entry }, input, options);
	const inner = typeof entry.issue === "string" ? new InvalidValue({ message: entry.issue }, input, options) : entry.issue;
	return new Pointer(entry.path, inner);
}
function makeSingle(out, input, options) {
	if (out === void 0) return;
	if (typeof out === "boolean") return out ? void 0 : new InvalidValue(void 0, input, options);
	return makeFilterIssue(out, input, options);
}
function normalizeFilterOutput(ast, out, input, options) {
	if (Array.isArray(out)) {
		if (!isReadonlyArrayNonEmpty(out)) return;
		return out.length === 1 ? makeFilterIssue(out[0], input, options) : new Composite(ast, map$2(out, (entry) => makeFilterIssue(entry, input, options)), input, options);
	}
	return makeSingle(out, input, options);
}
var defaultLeafHook = (issue) => {
	const message = findMessage(issue);
	if (message !== void 0) return message;
	switch (issue._tag) {
		case "InvalidType": return getExpectedMessage(getExpected(issue.ast), issue);
		case "InvalidValue": {
			const expected = findExpected(issue);
			if (expected !== void 0) return getExpectedMessage(expected, issue);
			const input = formatInput(issue);
			return input === void 0 ? "Expected a valid value" : `Invalid data ${input}`;
		}
		case "MissingKey": return "Missing key";
		case "UnexpectedKey": {
			const input = formatInput(issue);
			return input === void 0 ? "Expected no excess property" : `Unexpected key with value ${input}`;
		}
		case "Forbidden": return "Forbidden operation";
		case "OneOf": {
			const input = formatInput(issue);
			return input === void 0 ? "Expected exactly one member to match" : `Expected exactly one member to match the input ${input}`;
		}
	}
};
var defaultCheckHook = (issue) => findMessage(issue.issue) ?? findMessage(issue);
function makeFormatterStandardSchemaV1(options) {
	return (issue) => ({ issues: toDefaultIssues(issue, [], options?.leafHook ?? defaultLeafHook, options?.checkHook ?? defaultCheckHook) });
}
function formatInput(issue) {
	return hasInput(issue) ? format$1(issue.input) : void 0;
}
function findExpected(issue) {
	const expected = issue.annotations?.expected;
	return typeof expected === "string" ? expected : void 0;
}
function getExpectedMessage(expected, issue) {
	const input = formatInput(issue);
	return input === void 0 ? `Expected ${expected}` : `Expected ${expected}, got ${input}`;
}
function toDefaultIssues(issue, path, leafHook, checkHook) {
	switch (issue._tag) {
		case "Filter": {
			const message = checkHook(issue);
			if (message !== void 0) return [{
				path,
				message
			}];
			if (issue.issue._tag !== "InvalidValue") return toDefaultIssues(issue.issue, path, leafHook, checkHook);
			const expected = findExpected(issue.issue);
			return [{
				path,
				message: expected === void 0 ? getExpectedMessage(formatCheck(issue.filter), issue) : getExpectedMessage(expected, issue.issue)
			}];
		}
		case "Encoding": return toDefaultIssues(issue.issue, path, leafHook, checkHook);
		case "Pointer": return toDefaultIssues(issue.issue, [...path, ...issue.path], leafHook, checkHook);
		case "Composite": return issue.issues.flatMap((issue) => toDefaultIssues(issue, path, leafHook, checkHook));
		case "AnyOf":
			if (issue.issues.length === 0) return [{
				path,
				message: findMessage(issue) ?? getExpectedMessage(getExpected(issue.ast), issue)
			}];
			return issue.issues.flatMap((issue) => toDefaultIssues(issue, path, leafHook, checkHook));
		default: return [{
			path,
			message: leafHook(issue)
		}];
	}
}
function formatCheck(check) {
	const expected = check.annotations?.expected;
	if (typeof expected === "string") return expected;
	switch (check._tag) {
		case "Filter": return "<filter>";
		case "FilterGroup": return check.checks.map((check) => formatCheck(check)).join(" & ");
	}
}
function makeFormatterDefault() {
	return (issue) => formatIssue(issue, "");
}
var defaultFormatter = makeFormatterDefault();
function formatIssue(issue, path) {
	let message;
	switch (issue._tag) {
		case "Filter": {
			const annotated = defaultCheckHook(issue);
			if (annotated !== void 0) message = annotated;
			else {
				if (issue.issue._tag !== "InvalidValue") return formatIssue(issue.issue, path);
				const expected = findExpected(issue.issue);
				message = expected === void 0 ? getExpectedMessage(formatCheck(issue.filter), issue) : getExpectedMessage(expected, issue.issue);
			}
			break;
		}
		case "Encoding": return formatIssue(issue.issue, path);
		case "Pointer": return formatIssue(issue.issue, path + formatPath(issue.path));
		case "Composite":
		case "AnyOf":
			if (issue._tag === "Composite" || issue.issues.length > 0) return issue.issues.map((issue) => formatIssue(issue, path)).join("\n");
			message = findMessage(issue) ?? getExpectedMessage(getExpected(issue.ast), issue);
			break;
		default: message = defaultLeafHook(issue);
	}
	return path ? `${message}\n  at ${path}` : message;
}
function findMessage(issue) {
	if (issue._tag === "Pointer") return;
	if (issue._tag === "Encoding") return findMessage(issue.issue);
	const message = (issue._tag === "Filter" ? issue.filter.annotations : "annotations" in issue ? issue.annotations : issue.ast.annotations)?.[issue._tag === "MissingKey" ? "messageMissingKey" : issue._tag === "UnexpectedKey" ? "messageUnexpectedKey" : "message"];
	if (typeof message === "string") return message;
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/schema/cause.js
function getSchemaIssue(cause) {
	let issue;
	for (const reason of cause.reasons) {
		if (!isFailReason(reason) || !isIssue(reason.error)) return;
		issue ??= reason.error;
	}
	return issue;
}
function getSchemaIssueOrThrow(cause, message) {
	const issue = getSchemaIssue(cause);
	if (issue === void 0) throw new Error(message, { cause });
	return issue;
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/SchemaGetter.js
var makeGetter = (fields) => Object.assign(Object.create(Prototype$1), fields);
function fail(f) {
	return transformOptionalEffect((oe, options) => fail$1(f(oe, options)));
}
function forbidden(message) {
	return fail((oe, options) => {
		const annotations = { message: message(oe) };
		return isSome(oe) ? new Forbidden(annotations, oe.value, options) : new Forbidden(annotations);
	});
}
var forbiddenEncoding = forbidden(() => "Encoding is not supported");
var passthrough_$1 = makeGetter({ _tag: "Passthrough" });
function passthrough$1() {
	return passthrough_$1;
}
function transform$1(f) {
	return makeGetter({
		_tag: "Transform",
		transform: f
	});
}
function transformEffect$1(f) {
	return makeGetter({
		_tag: "TransformEffect",
		transform: f
	});
}
function transformOptionalEffect(f) {
	return makeGetter({
		_tag: "TransformOptionalEffect",
		transform: f
	});
}
function String$3() {
	return transform$1(globalThis.String);
}
function Number$3() {
	return transform$1(globalThis.Number);
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/SchemaTransformation.js
var Middleware = class extends Class$1 {
	_tag = "Middleware";
	decode;
	encode;
	constructor(decode, encode) {
		super();
		this.decode = decode;
		this.encode = encode;
	}
	flip() {
		return new Middleware(this.encode, this.decode);
	}
};
var TypeId$2 = "~effect/SchemaTransformation/Transformation";
var Transformation = class extends Class$1 {
	[TypeId$2] = TypeId$2;
	_tag = "Transformation";
	decode;
	encode;
	constructor(decode, encode) {
		super();
		this.decode = decode;
		this.encode = encode;
	}
	flip() {
		return new Transformation(this.encode, this.decode);
	}
};
function isTransformation(u) {
	return hasProperty(u, TypeId$2) && u[TypeId$2] === TypeId$2;
}
var makeTransformation = (options) => {
	if (isTransformation(options)) return options;
	return new Transformation(options.decode, options.encode);
};
function transformEffect(options) {
	return new Transformation(transformEffect$1(options.decode), transformEffect$1(options.encode));
}
var passthrough_ = new Transformation(passthrough$1(), passthrough$1());
function passthrough() {
	return passthrough_;
}
var numberFromString = new Transformation(Number$3(), String$3());
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/SchemaAST.js
function makeGuard(tag) {
	return (ast) => ast._tag === tag;
}
var isDeclaration = makeGuard("Declaration");
var isNever = makeGuard("Never");
var isLiteral = makeGuard("Literal");
var isUniqueSymbol = makeGuard("UniqueSymbol");
var isArrays = makeGuard("Arrays");
var isObjects = makeGuard("Objects");
var isSuspend = makeGuard("Suspend");
var Link = class {
	to;
	transformation;
	constructor(to, transformation) {
		this.to = to;
		this.transformation = transformation;
	}
};
var defaultParseOptions = {};
var Context = class {
	isOptional;
	isMutable;
	constructorDefault;
	annotations;
	constructor(isOptional, isMutable, constructorDefault = void 0, annotations = void 0) {
		this.isOptional = isOptional;
		this.isMutable = isMutable;
		this.constructorDefault = constructorDefault;
		this.annotations = annotations;
	}
};
var TypeId$1 = "~effect/Schema";
var ASTNodeImpl = class {
	[TypeId$1] = TypeId$1;
	annotations;
	checks;
	encoding;
	context;
	constructor(annotations = void 0, checks = void 0, encoding = void 0, context = void 0) {
		this.annotations = annotations;
		this.checks = checks;
		this.encoding = encoding;
		this.context = context;
	}
	toString() {
		return `<${this._tag}>`;
	}
};
var Declaration = class extends ASTNodeImpl {
	_tag = "Declaration";
	typeParameters;
	run;
	encodingChecks;
	encodingRun;
	constructor(typeParameters, run, annotations, checks, encoding, context, encodingChecks, encodingRun) {
		super(annotations, checks, encoding, context);
		this.typeParameters = typeParameters;
		this.run = run;
		this.encodingChecks = encodingChecks;
		this.encodingRun = encodingRun;
	}
	getParser() {
		let run;
		return (input, options) => {
			if (input === missing) return missingExit;
			return (run ??= this.run(this.typeParameters))(input, this, options);
		};
	}
	_rebuild(recur, checks, encodingChecks, run, encodingRun) {
		const tps = mapOrSame(this.typeParameters, recur);
		return tps === this.typeParameters && checks === this.checks && encodingChecks === this.encodingChecks && run === this.run && encodingRun === this.encodingRun ? this : new Declaration(tps, run, this.annotations, checks, void 0, this.context, encodingChecks, encodingRun);
	}
	recur(recur) {
		return this._rebuild(recur, this.checks, this.encodingChecks, this.run, this.encodingRun);
	}
	flip(recur) {
		return this._rebuild(recur, this.encodingChecks, this.checks, this.encodingRun ?? this.run, this.run);
	}
	getExpected() {
		const expected = this.annotations?.expected;
		if (typeof expected === "string") return expected;
		return "<Declaration>";
	}
};
var Null$1 = class extends ASTNodeImpl {
	_tag = "Null";
	getParser() {
		return fromConst(this, null);
	}
	getExpected() {
		return "null";
	}
};
var null_ = new Null$1();
var Unknown = class extends ASTNodeImpl {
	_tag = "Unknown";
	getParser() {
		return fromRefinement(this, isUnknown);
	}
	getExpected() {
		return "unknown";
	}
};
var unknown = new Unknown();
var Literal$1 = class extends ASTNodeImpl {
	_tag = "Literal";
	literal;
	constructor(literal, annotations, checks, encoding, context) {
		super(annotations, checks, encoding, context);
		if (typeof literal === "number" && !globalThis.Number.isFinite(literal)) throw new Error(`A numeric literal must be finite, got ${format$1(literal)}`);
		this.literal = literal;
	}
	getParser() {
		return fromConst(this, this.literal);
	}
	matchPart(s, _options) {
		return s === globalThis.String(this.literal) ? this.literal : void 0;
	}
	toCodecJson() {
		return typeof this.literal === "bigint" ? literalToString(this) : this;
	}
	toCodecStringTree() {
		return typeof this.literal === "string" ? this : literalToString(this);
	}
	getExpected() {
		return typeof this.literal === "string" ? JSON.stringify(this.literal) : globalThis.String(this.literal);
	}
};
function literalToString(ast) {
	const literalAsString = globalThis.String(ast.literal);
	return replaceEncoding(ast, [new Link(new Literal$1(literalAsString), new Transformation(transform$1(() => ast.literal), transform$1(() => literalAsString)))]);
}
var String$2 = class extends ASTNodeImpl {
	_tag = "String";
	getParser() {
		return fromRefinement(this, isString);
	}
	matchPart(s, options) {
		const checks = this.checks;
		return checks && !options.disableChecks && collectIssues(checks, s, void 0, this, options) ? void 0 : s;
	}
	getExpected() {
		return "string";
	}
};
var string = new String$2();
var Number$2 = class extends ASTNodeImpl {
	_tag = "Number";
	getParser() {
		return fromRefinement(this, isNumber);
	}
	matchKey(s, options) {
		return this._match(isStringNumberRegExp, s, options);
	}
	matchPart(s, options) {
		return this._match(isStringFiniteRegExp, s, options);
	}
	_match(regexp, s, options) {
		if (!regexp.test(s)) return void 0;
		const value = globalThis.Number(s);
		if (options.disableChecks || !this.checks) return value;
		return collectIssues(this.checks, value, void 0, this, options) ? void 0 : value;
	}
	toCodecJson() {
		if (this.checks && (hasCheck(this.checks, "effect/schema/isFinite") || hasCheck(this.checks, "effect/schema/isInt"))) return this;
		return replaceEncoding(this, [numberToJson]);
	}
	toCodecStringTree() {
		if (this.toCodecJson() === this) return replaceEncoding(this, [finiteToString]);
		return replaceEncoding(this, [numberToString]);
	}
	getExpected() {
		return "number";
	}
};
function hasCheck(checks, id) {
	return checks.some((check) => check.annotations?.representation?.id === id || check._tag === "FilterGroup" && hasCheck(check.checks, id));
}
var number = new Number$2();
var Boolean$1 = class extends ASTNodeImpl {
	_tag = "Boolean";
	getParser() {
		return fromRefinement(this, isBoolean);
	}
	getExpected() {
		return "boolean";
	}
};
var boolean = new Boolean$1();
var Arrays = class extends ASTNodeImpl {
	_tag = "Arrays";
	isMutable;
	elements;
	rest;
	encodingChecks;
	constructor(isMutable, elements, rest, annotations, checks, encoding, context, encodingChecks) {
		super(annotations, checks, encoding, context);
		this.isMutable = isMutable;
		this.elements = elements;
		this.rest = rest;
		this.encodingChecks = encodingChecks;
		let hasOptional = false;
		for (let i = 0; i < elements.length; i++) if (isOptional(elements[i])) hasOptional = true;
		else if (hasOptional) throw new Error("A required element cannot follow an optional element. ts(1257)");
		if (hasOptional && rest.length > 1) throw new Error("A required element cannot follow an optional element. ts(1257)");
		for (let i = 1; i < rest.length; i++) if (isOptional(rest[i])) throw new Error("An optional element cannot follow a rest element. ts(1266)");
	}
	getParser(compile, compileField = compile) {
		const ast = this;
		let elements;
		let rest;
		const elementLen = ast.elements.length;
		const tailLen = Math.max(0, ast.rest.length - 1);
		function getParser(tailThreshold, index) {
			if (index < elementLen) return elements[index];
			else if (index >= tailThreshold) return rest[index - tailThreshold + 1];
			return rest[0];
		}
		const finish = (state) => {
			const { input, len, options } = state;
			if (ast.rest.length === 0 && len > elementLen) for (let i = elementLen; i < len; i++) {
				const unexpected = new UnexpectedKey(ast, input[i], options);
				const issue = new Pointer([i], unexpected);
				if (options.errors === "all") {
					if (state.issues) state.issues.push(issue);
					else state.issues = [issue];
				} else return fail$1(new Composite(ast, [issue], input, options));
			}
			if (state.issues) return fail$1(new Composite(ast, state.issues, input, options));
			return succeed(state.output);
		};
		const parse = (input, options) => {
			const len = input.length;
			const state = {
				ast,
				getParser,
				input,
				len,
				tailThreshold: Math.max(elementLen, len - tailLen),
				output: new globalThis.Array(len),
				issues: void 0,
				options
			};
			const end = ast.rest.length === 0 ? elementLen : Math.max(len, elementLen + tailLen);
			const concurrency = options.concurrency === void 0 ? 1 : resolveConcurrency(options.concurrency);
			const eff = concurrency === 1 ? parseArray(state, input, 0, end) : parseArrayConcurrent(state, input, {
				concurrency,
				end
			});
			if (!eff) return finish(state);
			if (effectIsExit(eff)) return flatMapEager(eff, () => finish(state));
			let first = true;
			return suspend(() => {
				if (!first) return parse(input, options);
				first = false;
				return flatMap(eff, () => finish(state));
			});
		};
		return (input, options) => {
			if (input === missing) return missingExit;
			try {
				if (!Array.isArray(input)) return fail$1(new InvalidType(ast, input, options));
				if (!elements) {
					elements = ast.elements.map((ast) => ({
						ast,
						parser: compileField(ast)
					}));
					rest = ast.rest.map((ast) => ({
						ast,
						parser: compileField(ast)
					}));
				}
				return parse(input, options);
			} catch (error) {
				return die(error);
			}
		};
	}
	_rebuild(recur, checks, encodingChecks) {
		const elements = mapOrSame(this.elements, recur);
		const rest = mapOrSame(this.rest, recur);
		return elements === this.elements && rest === this.rest && checks === this.checks && encodingChecks === this.encodingChecks ? this : new Arrays(this.isMutable, elements, rest, this.annotations, checks, void 0, this.context, encodingChecks);
	}
	recur(recur) {
		return this._rebuild(recur, this.checks, this.encodingChecks);
	}
	flip(recur) {
		return this._rebuild(recur, this.encodingChecks, this.checks);
	}
	getExpected() {
		return "array";
	}
};
function stepArray(s, item, exit, i) {
	if (exit._tag === "Failure") return wrapPropertyKeyIssue(s, s.ast, i, exit);
	const value = exit === sameExit ? item : exit[args];
	if (value !== missing) s.output[i] = value;
	else {
		const p = s.getParser(s.tailThreshold, i);
		if (isOptional(p.ast)) return;
		const issue = new Pointer([i], new MissingKey(p.ast.context?.annotations));
		if (s.options.errors === "all") {
			if (s.issues) s.issues.push(issue);
			else s.issues = [issue];
		} else return fail$2(new Composite(s.ast, [issue], s.input, s.options));
	}
}
var parseArrayOptions = {
	onItem(s, item, i) {
		const value = i < s.len ? item : missing;
		return s.getParser(s.tailThreshold, i).parser(value, s.options);
	},
	step: stepArray
};
var parseArray = iterateEager()(parseArrayOptions);
var parseArrayConcurrent = iterateConcurrent()(parseArrayOptions);
var wrapPropertyKeyIssue = (s, ast, key, exit) => {
	if (exit.cause.reasons.length === 0) return exit;
	const issue = getSchemaIssue(exit.cause);
	if (issue === void 0) return failCause(map(exit.cause, (issue) => new Composite(ast, [new Pointer([key], issue)], s.input, s.options)));
	const pointer = new Pointer([key], issue);
	if (s.options.errors === "all") {
		if (s.issues) s.issues.push(pointer);
		else s.issues = [pointer];
	} else return fail$2(new Composite(ast, [pointer], s.input, s.options));
};
var FINITE_PATTERN = "[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?";
function getIndexSignatureKeys(input, parameter, options = defaultParseOptions) {
	let stringKeys;
	let symbolKeys;
	function go(parameter) {
		switch (parameter._tag) {
			case "String":
			case "TemplateLiteral": return (stringKeys ??= Object.keys(input)).filter((k) => parameter.matchPart(k, options) !== void 0);
			case "Number": return (stringKeys ??= Object.keys(input)).filter((k) => parameter.matchKey(k, options) !== void 0);
			case "Symbol": return (symbolKeys ??= Object.getOwnPropertySymbols(input)).filter((k) => Object.prototype.propertyIsEnumerable.call(input, k) && parameter.matchKey(k, options) !== void 0);
			case "Union": return [...new Set(parameter.types.flatMap(go))];
			default: return [];
		}
	}
	return go(parameterFromPropertyKey(toEncoded(parameter)));
}
var PropertySignature = class {
	name;
	type;
	constructor(name, type) {
		this.name = name;
		this.type = type;
	}
};
function isIndexSignatureParameterSide(ast) {
	switch (ast._tag) {
		case "String":
		case "Number":
		case "Symbol":
		case "TemplateLiteral": return true;
		case "Union": return ast.types.every(isIndexSignatureParameterSide);
		default: return false;
	}
}
function isIndexSignatureParameterEncodedSide(ast) {
	const encoded = getLastEncoding(ast);
	switch (encoded._tag) {
		case "String":
		case "Number":
		case "Symbol":
		case "TemplateLiteral": return true;
		case "Union": return encoded.types.every(isIndexSignatureParameterEncodedSide);
		default: return false;
	}
}
function isIndexSignatureParameter(ast) {
	return isIndexSignatureParameterSide(ast) && isIndexSignatureParameterEncodedSide(ast);
}
var IndexSignature = class {
	parameter;
	type;
	constructor(parameter, type) {
		if (!isIndexSignatureParameter(parameter)) throw new Error(`Invalid index signature parameter ${parameter._tag}`);
		this.parameter = parameter;
		this.type = type;
		if (isOptional(type) && !containsUndefined(type)) throw new Error("Cannot use `Schema.optionalKey` with index signatures, use `Schema.optional` instead.");
	}
};
var Objects = class extends ASTNodeImpl {
	_tag = "Objects";
	propertySignatures;
	indexSignatures;
	encodingChecks;
	constructor(propertySignatures, indexSignatures, annotations, checks, encoding, context, encodingChecks) {
		super(annotations, checks, encoding, context);
		this.propertySignatures = propertySignatures;
		this.indexSignatures = indexSignatures;
		this.encodingChecks = encodingChecks;
	}
	getParser(compile, compileField = compile) {
		const ast = this;
		const hasProperties = ast.propertySignatures.length;
		const indexCount = ast.indexSignatures.length;
		if (!hasProperties && !indexCount) return fromRefinement(ast, isNotNullish);
		let properties;
		let indexes;
		const compileMembers = () => {
			if (!properties) {
				properties = ast.propertySignatures.map((ps) => ({
					parser: compileField(ps.type),
					name: ps.name,
					type: ps.type
				}));
				indexes = indexCount ? ast.indexSignatures.map((is) => ({
					is,
					parserKey: compile(parameterFromPropertyKey(is.parameter)),
					parserValue: compileField(is.type)
				})) : void 0;
			}
			return properties;
		};
		const makeFallback = () => {
			const expectedKeys = new Set(ast.propertySignatures.map((ps) => typeof ps.name === "number" ? globalThis.String(ps.name) : ps.name));
			const finishIndex = (s, key, k2, inputValue, exitValue) => {
				if (exitValue._tag === "Failure") return wrapPropertyKeyIssue(s, ast, key, exitValue) ?? void_;
				const value = exitValue === sameExit ? inputValue : exitValue[args];
				if (k2 !== missing && value !== missing) {
					if (hasProperties && (expectedKeys.has(key) || expectedKeys.has(typeof k2 === "number" ? globalThis.String(k2) : k2))) return void_;
					assignProperty(s.out, k2, value);
				}
				return void_;
			};
			const parseIndex = (s, key, index, exitKey) => {
				if (!exitKey) {
					const eff = index.parserKey(key, s.options);
					if (!effectIsExit(eff)) return flatMap(exit(eff), (exit) => parseIndex(s, key, index, exit));
					exitKey = eff;
				}
				if (exitKey._tag === "Failure") return wrapPropertyKeyIssue(s, ast, key, exitKey) ?? void_;
				const k2 = exitKey === sameExit ? key : exitKey[args];
				const inputValue = s.input[key];
				const result = index.parserValue(inputValue, s.options);
				return effectIsExit(result) ? finishIndex(s, key, k2, inputValue, result) : flatMap(exit(result), (exit) => finishIndex(s, key, k2, inputValue, exit));
			};
			const parseStringIndex = (s, key, index) => {
				const inputValue = s.input[key];
				const result = index.parserValue(inputValue, s.options);
				return effectIsExit(result) ? finishIndex(s, key, key, inputValue, result) : flatMap(exit(result), (exit) => finishIndex(s, key, key, inputValue, exit));
			};
			const parseIndexes = indexCount ? iterateConcurrent()({
				onItem: (s, [key, index]) => index.is.parameter === string ? parseStringIndex(s, key, index) : parseIndex(s, key, index),
				step: (_s, _item, exit) => exit._tag === "Failure" ? exit : void 0
			}) : void 0;
			return fnUntracedEager(function* (input, options) {
				if (input === missing) return missing;
				if (!(typeof input === "object" && input !== null && !Array.isArray(input))) return yield* fail$1(new InvalidType(ast, input, options));
				compileMembers();
				const record = input;
				const out = {};
				const state = {
					ast,
					input: record,
					out,
					issues: void 0,
					options
				};
				const errorsAllOption = options.errors === "all";
				const onExcessPropertyError = options.onExcessProperty === "error";
				const concurrency = options.concurrency === void 0 ? 1 : resolveConcurrency(options.concurrency);
				const indexKeys = indexCount && onExcessPropertyError ? ast.indexSignatures.map((index) => getIndexSignatureKeys(record, index.parameter, options)) : void 0;
				if (onExcessPropertyError) {
					const coveredKeys = indexKeys ? new Set(expectedKeys) : expectedKeys;
					if (indexKeys) for (const keys of indexKeys) for (const key of keys) coveredKeys.add(key);
					const inputKeys = Reflect.ownKeys(record);
					for (let i = 0; i < inputKeys.length; i++) {
						const key = inputKeys[i];
						if (!coveredKeys.has(key) && Object.prototype.propertyIsEnumerable.call(record, key)) {
							const unexpected = new UnexpectedKey(ast, record[key], options);
							const issue = new Pointer([key], unexpected);
							if (errorsAllOption) {
								if (state.issues) state.issues.push(issue);
								else state.issues = [issue];
								continue;
							} else return yield* fail$1(new Composite(ast, [issue], input, options));
						}
					}
				}
				if (hasProperties) {
					const eff = concurrency === 1 ? parseProperties(state, properties) : parsePropertiesConcurrent(state, properties, { concurrency });
					if (eff) yield* eff;
				}
				if (indexCount && concurrency === 1) for (let i = 0; i < indexCount; i++) {
					const index = indexes[i];
					const parse = index.is.parameter === string ? parseStringIndex : parseIndex;
					const keys = indexKeys?.[i] ?? (index.is.parameter === string ? Object.keys(record) : getIndexSignatureKeys(record, index.is.parameter, options));
					for (let j = 0; j < keys.length; j++) {
						const eff = parse(state, keys[j], index);
						if (!effectIsExit(eff)) yield* eff;
						else if (eff._tag === "Failure") return yield* eff;
					}
				}
				else if (parseIndexes) {
					const keyPairs = empty();
					for (let i = 0; i < indexCount; i++) {
						const index = indexes[i];
						const keys = indexKeys?.[i] ?? (index.is.parameter === string ? Object.keys(record) : getIndexSignatureKeys(record, index.is.parameter, options));
						for (let j = 0; j < keys.length; j++) keyPairs.push([keys[j], index]);
					}
					const eff = parseIndexes(state, keyPairs, { concurrency });
					if (eff) yield* eff;
				}
				if (state.issues) return yield* fail$1(new Composite(ast, state.issues, input, options));
				return out;
			});
		};
		if (indexCount) return makeFallback();
		let fallback;
		const resume = (state, index, pending) => {
			const property = properties[index];
			return flatMap(exit(pending), (exit) => {
				const terminal = stepProperty(state, property, exit);
				if (terminal) return terminal;
				const done = () => succeed(state.out);
				const eff = parseProperties(state, properties.slice(index + 1));
				return eff ? flatMapEager(eff, done) : done();
			});
		};
		return (input, options) => {
			if (input === missing) return missingExit;
			if (options.errors === "all" || options.onExcessProperty !== void 0 || options.concurrency !== void 0 && resolveConcurrency(options.concurrency) !== 1) return (fallback ??= makeFallback())(input, options);
			if (!(typeof input === "object" && input !== null && !Array.isArray(input))) return fail$1(new InvalidType(ast, input, options));
			const props = compileMembers();
			const record = input;
			const out = {};
			const state = {
				ast,
				input: record,
				out,
				issues: void 0,
				options
			};
			try {
				for (let index = 0; index < props.length; index++) {
					const property = props[index];
					const name = property.name;
					const hasKey = hasPropertySignature(record, name);
					const value = hasKey ? record[name] : missing;
					const exit = property.parser(value, options);
					if (!effectIsExit(exit)) return resume(state, index, exit);
					if (exit === sameExit) {
						if (hasKey) assignProperty(out, name, value);
						continue;
					}
					const terminal = stepProperty(state, property, exit);
					if (terminal) return terminal;
				}
			} catch (error) {
				return die(error);
			}
			return succeed(out);
		};
	}
	_rebuild(recur, recurParameter, checks, encodingChecks) {
		const props = mapOrSame(this.propertySignatures, (ps) => {
			const t = recur(ps.type);
			return t === ps.type ? ps : new PropertySignature(ps.name, t);
		});
		const indexes = mapOrSame(this.indexSignatures, (is) => {
			const p = recurParameter(is.parameter);
			const t = recur(is.type);
			return p === is.parameter && t === is.type ? is : new IndexSignature(p, t);
		});
		return props === this.propertySignatures && indexes === this.indexSignatures && checks === this.checks && encodingChecks === this.encodingChecks ? this : new Objects(props, indexes, this.annotations, checks, void 0, this.context, encodingChecks);
	}
	flip(recur) {
		return this._rebuild(recur, recur, this.encodingChecks, this.checks);
	}
	recur(recur, recurParameter = recur) {
		return this._rebuild(recur, recurParameter, this.checks, this.encodingChecks);
	}
	getExpected() {
		if (this.propertySignatures.length === 0 && this.indexSignatures.length === 0) return "object | array";
		return "object";
	}
};
function stepProperty(s, p, exit) {
	if (exit._tag === "Failure") return wrapPropertyKeyIssue(s, s.ast, p.name, exit);
	if (exit === sameExit) return;
	const value = exit[args];
	if (value !== missing) {
		assignProperty(s.out, p.name, value);
		return;
	}
	delete s.out[p.name];
	if (!isOptional(p.type)) {
		const issue = new Pointer([p.name], new MissingKey(p.type.context?.annotations));
		if (s.options.errors === "all") {
			if (s.issues) s.issues.push(issue);
			else s.issues = [issue];
			return;
		} else return fail$2(new Composite(s.ast, [issue], s.input, s.options));
	}
}
var parsePropertiesOptions = {
	onItem(s, p) {
		if (!hasPropertySignature(s.input, p.name)) return p.parser(missing, s.options);
		const value = s.input[p.name];
		assignProperty(s.out, p.name, value);
		return p.parser(value, s.options);
	},
	step: stepProperty
};
var parseProperties = iterateEager()(parsePropertiesOptions);
var parsePropertiesConcurrent = iterateConcurrent()(parsePropertiesOptions);
function combineChecks(a, b) {
	if (!a) return b;
	if (!b) return a;
	return [...a, ...b];
}
function struct(fields, checks, annotations) {
	return new Objects(Reflect.ownKeys(fields).map((key) => {
		return new PropertySignature(key, fields[key].ast);
	}), [], annotations, checks);
}
function getAST(self) {
	return self.ast;
}
function union(members, options, checks) {
	return new Union$1(members.map(getAST), options, void 0, checks);
}
var toCandidate = memoizeIdempotent((ast) => {
	while (true) {
		if (isSuspend(ast)) return unknown;
		const encoding = ast.encoding;
		if (!encoding) return ast.recur?.(toCandidate, identity) ?? ast;
		if (encoding.some((link) => link.transformation._tag === "Middleware" && link.transformation.decode !== identity)) return unknown;
		ast = encoding[encoding.length - 1].to;
	}
});
function getCandidateTypes(ast) {
	switch (ast._tag) {
		case "Null": return ["null"];
		case "Undefined": return ["undefined"];
		case "String":
		case "TemplateLiteral": return ["string"];
		case "Number": return ["number"];
		case "Boolean": return ["boolean"];
		case "Symbol":
		case "UniqueSymbol": return ["symbol"];
		case "BigInt": return ["bigint"];
		case "Arrays": return ["array"];
		case "ObjectKeyword": return [
			"object",
			"array",
			"function"
		];
		case "Objects": return ast.propertySignatures.length || ast.indexSignatures.length ? ["object"] : [
			"string",
			"number",
			"boolean",
			"symbol",
			"bigint",
			"object",
			"array",
			"function"
		];
		case "Enum": return Array.from(new Set(ast.enums.map(([, v]) => typeof v)));
		case "Literal": return [typeof ast.literal];
		case "Union": return Array.from(new Set(ast.types.flatMap(getCandidateTypes)));
		default: return [
			"null",
			"undefined",
			"string",
			"number",
			"boolean",
			"symbol",
			"bigint",
			"object",
			"array",
			"function"
		];
	}
}
function collectSentinels(ast) {
	switch (ast._tag) {
		default: return [];
		case "Declaration": {
			const s = ast.annotations?.[SENTINELS_ANNOTATION_KEY];
			return Array.isArray(s) ? s : [];
		}
		case "Objects": return ast.propertySignatures.flatMap((ps) => {
			const type = ps.type;
			if (!isOptional(type)) {
				if (isLiteral(type)) return [{
					key: ps.name,
					literal: type.literal
				}];
				if (isUniqueSymbol(type)) return [{
					key: ps.name,
					literal: type.symbol
				}];
			}
			return [];
		});
		case "Arrays": return ast.elements.flatMap((e, i) => {
			if (!isOptional(e)) {
				if (isLiteral(e)) return [{
					key: i,
					literal: e.literal
				}];
				if (isUniqueSymbol(e)) return [{
					key: i,
					literal: e.symbol
				}];
			}
			return [];
		});
		case "Union": {
			if (ast.types.length === 0) return [];
			const members = ast.types.map((type) => collectSentinels(toCandidate(type)));
			return members[0].filter((s) => members.every((sentinels) => sentinels.some((o) => o.key === s.key && o.literal === s.literal)));
		}
		case "Suspend": return collectSentinels(ast.thunk());
	}
}
var candidateIndexCache = new WeakMap();
var emptyCandidates = Object.freeze([]);
var getRuntimeType = (input) => input === null ? "null" : Array.isArray(input) ? "array" : typeof input;
var hasPropertySignature = (input, key) => key === "__proto__" ? Object.hasOwn(input, key) : key in input;
function getCandidateIndex(types) {
	let index = candidateIndexCache.get(types);
	if (index) return index;
	let bySentinel;
	let sentinelCandidateCount = 0;
	let otherwise;
	let literalCandidates;
	let onlyLiterals = true;
	const literalOf = [];
	for (let i = 0; i < types.length; i++) {
		const a = types[i];
		const encoded = toCandidate(a);
		if (isNever(encoded)) continue;
		if (isLiteral(encoded) || isUniqueSymbol(encoded)) {
			literalCandidates ??= new Map();
			const literal = isLiteral(encoded) ? encoded.literal : encoded.symbol;
			literalOf[i] = literal;
			let arr = literalCandidates.get(literal);
			if (!arr) literalCandidates.set(literal, arr = []);
			arr.push(i);
		} else onlyLiterals = false;
		const sentinels = collectSentinels(encoded);
		if (sentinels.length) {
			bySentinel ??= new Map();
			sentinelCandidateCount++;
			for (const { key, literal } of sentinels) {
				let entry = bySentinel.get(key);
				if (!entry) bySentinel.set(key, entry = [new Map(), new Set()]);
				entry[1].add(i);
				let indexes = entry[0].get(literal);
				if (!indexes) entry[0].set(literal, indexes = new Set());
				indexes.add(i);
			}
		} else {
			otherwise ??= {};
			const candidateTypes = getCandidateTypes(encoded);
			for (const t of candidateTypes) (otherwise[t] ??= []).push(i);
		}
	}
	const fallbacks = {};
	const getFallback = (type) => fallbacks[type] ??= Object.freeze(otherwise?.[type] ?? emptyCandidates);
	if (onlyLiterals && literalCandidates) {
		literalCandidates.forEach(Object.freeze);
		index = (input) => literalCandidates.get(input) ?? emptyCandidates;
	} else if (bySentinel?.size === 1 && !otherwise) {
		const [key, [byValue]] = bySentinel.entries().next().value;
		const candidates = new Map();
		for (const [literal, indexes] of byValue) candidates.set(literal, Object.freeze(Array.from(indexes)));
		const all = Object.freeze(types.map((_, i) => i));
		index = (input, isConstructor) => {
			if (isObjectKeyword(input)) {
				const value = hasPropertySignature(input, key) ? input[key] : void 0;
				if (value !== void 0) return candidates.get(value) ?? emptyCandidates;
				if (isConstructor) return all;
			}
			return emptyCandidates;
		};
	} else if (bySentinel) {
		let commonSentinel;
		for (const entry of bySentinel) if ((!commonSentinel || entry[1][0].size > commonSentinel[1][0].size) && entry[1][1].size === sentinelCandidateCount) commonSentinel = entry;
		index = (input, isConstructor) => {
			const runtimeType = getRuntimeType(input);
			if (!isObjectKeyword(input)) return getFallback(runtimeType);
			const selected = new Set(otherwise?.[runtimeType]);
			let directKey;
			if (commonSentinel) {
				const [key, [byValue]] = commonSentinel;
				const hasKey = hasPropertySignature(input, key);
				const value = hasKey ? input[key] : void 0;
				if (hasKey && (!isConstructor || value !== void 0)) {
					const match = byValue.get(value);
					if (!match) return getFallback(runtimeType);
					for (const i of match) selected.add(i);
					directKey = key;
				}
			}
			if (directKey === void 0) for (const [key, [byValue, all]] of bySentinel) {
				const hasKey = hasPropertySignature(input, key);
				const value = hasKey ? input[key] : void 0;
				if (hasKey && (!isConstructor || value !== void 0)) {
					const match = byValue.get(value);
					if (match) for (const i of match) selected.add(i);
				} else if (isConstructor) for (const i of all) selected.add(i);
			}
			for (const [key, [byValue, all]] of bySentinel) {
				if (key === directKey) continue;
				const hasKey = hasPropertySignature(input, key);
				const value = hasKey ? input[key] : void 0;
				if (hasKey && (!isConstructor || value !== void 0)) {
					const match = byValue.get(value);
					for (const i of selected) if (all.has(i) && !match?.has(i)) selected.delete(i);
				}
			}
			return Array.from(selected).sort((a, b) => a - b);
		};
	} else index = (input) => {
		const fallback = getFallback(getRuntimeType(input));
		return literalCandidates ? fallback.filter((i) => literalOf[i] === void 0 || literalOf[i] === input) : fallback;
	};
	candidateIndexCache.set(types, index);
	return index;
}
var Union$1 = class extends ASTNodeImpl {
	_tag = "Union";
	types;
	options;
	encodingChecks;
	constructor(types, options, annotations, checks, encoding, context, encodingChecks) {
		super(annotations, checks, encoding, context);
		this.types = types;
		this.options = options;
		this.encodingChecks = encodingChecks;
	}
	getParser(compile, compileField) {
		const ast = this;
		const isConstructor = compileField !== void 0;
		const parsers = [];
		const parser = (i) => parsers[i] ??= compile(ast.types[i]);
		let index;
		return (input, options) => {
			if (input === missing) return missingExit;
			const candidates = (index ??= getCandidateIndex(ast.types))(input, isConstructor);
			if (candidates.length === 0) return fail$1(new AnyOf(ast, [], input, options));
			if (candidates.length === 1) {
				const result = parser(candidates[0])(input, options);
				if (result._tag === "Success") return result;
				return effectIsExit(result) ? failSingleUnionCandidate(ast, result.cause, input, options) : catchSingleUnionCandidate(ast, result, input, options);
			}
			return parseUnionCandidates(ast, parser, candidates, input, options);
		};
	}
	_rebuild(recur, checks, encodingChecks) {
		const types = mapOrSame(this.types, recur);
		return types === this.types && checks === this.checks && encodingChecks === this.encodingChecks ? this : new Union$1(types, this.options, this.annotations, checks, void 0, this.context, encodingChecks);
	}
	recur(recur) {
		return this._rebuild(recur, this.checks, this.encodingChecks);
	}
	flip(recur) {
		return this._rebuild(recur, this.encodingChecks, this.checks);
	}
	matchPart(s, options) {
		for (const type of this.types) {
			const out = type.matchPart(s, options);
			if (out !== void 0) return out;
		}
	}
	getExpected(getExpected) {
		const expected = this.annotations?.expected;
		if (typeof expected === "string") return expected;
		if (this.types.length === 0) return "never";
		const types = this.types.map((type) => {
			const encoded = toEncoded(type);
			switch (encoded._tag) {
				case "Arrays": {
					const literals = encoded.elements.filter(isLiteral);
					if (literals.length > 0) return `${formatIsMutable(encoded.isMutable)}[ ${literals.map((e) => getExpected(e) + formatIsOptional(e.context?.isOptional)).join(", ")}, ... ]`;
					break;
				}
				case "Objects": {
					const literals = encoded.propertySignatures.filter((ps) => isLiteral(ps.type));
					if (literals.length > 0) return `{ ${literals.map((ps) => `${formatIsMutable(ps.type.context?.isMutable)}${formatPropertyKey(ps.name)}${formatIsOptional(ps.type.context?.isOptional)}: ${getExpected(ps.type)}`).join(", ")}, ... }`;
					break;
				}
			}
			return getExpected(encoded);
		});
		return Array.from(new Set(types)).join(" | ");
	}
};
function failSingleUnionCandidate(ast, cause, input, options) {
	const issue = getSchemaIssue(cause);
	if (!issue) return failCause(cause);
	return fail$2(new AnyOf(ast, [issue], input, options));
}
function catchSingleUnionCandidate(ast, result, input, options) {
	return catchCause(result, (cause) => failSingleUnionCandidate(ast, cause, input, options));
}
function parseUnionCandidates(ast, parser, candidates, input, options) {
	const state = {
		ast,
		parser,
		input,
		out: void 0,
		successes: ast.options?.mode === "oneOf" ? [] : void 0,
		issues: void 0,
		options
	};
	const eff = parseUnion(state, candidates);
	if (!eff) {
		if (state.out) return state.out;
		return fail$1(new AnyOf(ast, state.issues ?? [], input, options));
	}
	return resumeUnion(eff, state);
}
function resumeUnion(eff, state) {
	return flatMapEager(eff, (_) => {
		if (state.out === sameExit) return succeed$1(state.input);
		if (state.out) return state.out;
		return fail$1(new AnyOf(state.ast, state.issues ?? [], state.input, state.options));
	});
}
var parseUnion = iterateEager()({
	onItem(s, i) {
		return s.parser(i)(s.input, s.options);
	},
	step(s, i, exit) {
		if (exit._tag === "Failure") {
			const issue = getSchemaIssue(exit.cause);
			if (issue === void 0) return exit;
			if (s.issues) s.issues.push(issue);
			else s.issues = [issue];
		} else {
			if (s.out && s.successes) {
				s.successes.push(s.ast.types[i]);
				return fail$2(new OneOf(s.ast, s.successes, s.input, s.options));
			}
			s.out = exit;
			if (s.successes) s.successes.push(s.ast.types[i]);
			else return void_;
		}
	}
});
var nonFiniteLiterals = new Union$1([
	new Literal$1("Infinity"),
	new Literal$1("-Infinity"),
	new Literal$1("NaN")
]);
function formatIsMutable(isMutable) {
	return isMutable ? "" : "readonly ";
}
function formatIsOptional(isOptional) {
	return isOptional ? "?" : "";
}
var Filter = class extends Class$1 {
	_tag = "Filter";
	run;
	annotations;
	aborted;
	constructor(run, annotations = void 0, aborted = false) {
		super();
		this.run = run;
		this.annotations = annotations;
		this.aborted = aborted;
	}
	annotate(annotations) {
		return new Filter(this.run, {
			...this.annotations,
			...annotations
		}, this.aborted);
	}
	abort() {
		return new Filter(this.run, this.annotations, true);
	}
	and(other, annotations) {
		return new FilterGroup([this, other], annotations);
	}
};
var FilterGroup = class extends Class$1 {
	_tag = "FilterGroup";
	checks;
	annotations;
	constructor(checks, annotations = void 0) {
		super();
		this.checks = checks;
		this.annotations = annotations;
	}
	annotate(annotations) {
		return new FilterGroup(this.checks, {
			...this.annotations,
			...annotations
		});
	}
	and(other, annotations) {
		return new FilterGroup([this, other], annotations);
	}
};
function makeFilter$1(filter, annotations, aborted = false) {
	return new Filter((input, ast, options) => normalizeFilterOutput(ast, filter(input, ast, options), input, options), annotations, aborted);
}
function isFinite(annotations) {
	return makeFilter$1((n) => globalThis.Number.isFinite(n), {
		expected: "a finite number",
		representation: {
			id: "effect/schema/isFinite",
			payload: null
		},
		toJsonSchema: () => ({ type: "number" }),
		toCode: () => ({ runtime: "Schema.isFinite()" }),
		arbitraryConstraint: { number: "finite" },
		...annotations
	});
}
var numberToJson = new Link(new Union$1([appendChecks(number, [isFinite()]), nonFiniteLiterals]), new Transformation(Number$3(), transform$1((n) => globalThis.Number.isFinite(n) ? n : globalThis.String(n))));
function isPattern$1(regExp, annotations) {
	const copy = new globalThis.RegExp(regExp);
	const payload = {
		source: copy.source,
		flags: copy.flags
	};
	return makeFilter$1((s) => {
		copy.lastIndex = 0;
		return copy.test(s);
	}, {
		expected: `a string matching the RegExp ${payload.source}`,
		representation: {
			id: "effect/schema/isPattern",
			payload
		},
		toJsonSchema: () => [{}, true],
		arbitraryConstraint: { patterns: [payload] },
		...annotations
	});
}
var bodyOwners = new WeakMap();
function copy(ast, changes) {
	const out = Object.assign(Object.create(Object.getPrototypeOf(ast)), ast, changes);
	if (Reflect.ownKeys(changes).every((key) => key === "context" || key === "encoding")) bodyOwners.set(out, getContextOwner(ast));
	return out;
}
function getContextOwner(ast) {
	const existing = bodyOwners.get(ast);
	if (existing !== void 0) return existing;
	if (ast.encoding === void 0) return ast;
	const owner = Object.assign(Object.create(Object.getPrototypeOf(ast)), ast, { encoding: void 0 });
	bodyOwners.set(ast, owner);
	return owner;
}
function replaceEncoding(ast, encoding) {
	return ast.encoding === encoding ? ast : copy(ast, { encoding });
}
function replaceContext(ast, context) {
	if (ast.context === context) return ast;
	const owner = getContextOwner(ast);
	if (owner.context === context && owner.encoding === ast.encoding) return owner;
	return copy(ast, { context });
}
function getLastEncoding(ast) {
	return ast.encoding ? getLastEncoding(ast.encoding[ast.encoding.length - 1].to) : ast;
}
function annotate(ast, annotations) {
	if (ast.checks) {
		const last = ast.checks[ast.checks.length - 1];
		return replaceChecks(ast, append(ast.checks.slice(0, -1), last.annotate(annotations)));
	}
	return copy(ast, { annotations: {
		...ast.annotations,
		...annotations
	} });
}
function replaceChecks(ast, checks) {
	if (ast._tag === "Suspend" && checks) throw new Error("Cannot add checks to Suspend");
	if (ast.checks === checks) return ast;
	return copy(ast, { checks });
}
function appendChecks(ast, checks) {
	return replaceChecks(ast, combineChecks(ast.checks, checks));
}
function mapLink(link, f) {
	const to = f(link.to);
	return to === link.to ? link : new Link(to, link.transformation);
}
function updateLastLink(encoding, f) {
	const links = encoding;
	const last = links[links.length - 1];
	const out = mapLink(last, f);
	return out === last ? encoding : append(encoding.slice(0, encoding.length - 1), out);
}
function applyToSelfOrLastLinkEncodingIdempotent(f, options) {
	function out(ast) {
		if (ast.encoding) {
			const last = ast.encoding[ast.encoding.length - 1];
			return options?.stopAt?.(last) ? ast : replaceEncoding(ast, updateLastLink(ast.encoding, out));
		}
		return f(ast);
	}
	return memoizeIdempotent(out);
}
function appendTransformation(from, transformation, to) {
	const link = new Link(from, transformation);
	return replaceEncoding(to, to.encoding ? [...to.encoding, link] : [link]);
}
function mapOrSame(as, f) {
	let out;
	for (let i = 0; i < as.length; i++) {
		const a = as[i];
		const fa = f(a);
		if (out) out[i] = fa;
		else if (fa !== a) {
			out = new Array(as.length);
			for (let j = 0; j < i; j++) out[j] = as[j];
			out[i] = fa;
		}
	}
	return out ?? as;
}
function annotateKey(ast, annotations) {
	return replaceContext(ast, ast.context ? new Context(ast.context.isOptional, ast.context.isMutable, ast.context.constructorDefault, {
		...ast.context.annotations,
		...annotations
	}) : new Context(false, false, void 0, annotations));
}
function decodeTo$1(from, to, transformation) {
	return appendTransformation(from, transformation, to);
}
function isOptional(ast) {
	return ast.context?.isOptional ?? false;
}
function isStructuralCheck(check) {
	return check.annotations?.["~structural"] === true || check._tag === "FilterGroup" && check.checks.every(isStructuralCheck);
}
function extractStructuralChecks(checks) {
	function extract(check) {
		if (isStructuralCheck(check)) return [check];
		return check._tag === "FilterGroup" ? check.checks.flatMap(extract) : [];
	}
	const out = checks.flatMap(extract);
	return isArrayNonEmpty(out) ? out : void 0;
}
function canPreserveEncodingChecks(ast) {
	let preserve = true;
	function visit(child) {
		preserve = preserve && !child.encoding && !isSuspend(child);
		if (preserve && "recur" in child) child.recur(visit);
		return child;
	}
	if ("recur" in ast) ast.recur(visit);
	return preserve;
}
var toType = memoizeIdempotent((ast) => {
	const owner = getContextOwner(ast);
	if (owner !== ast) {
		const type = toType(owner);
		return type === owner && ast.encoding === void 0 ? ast : replaceContext(type, ast.context);
	}
	const type = "recur" in ast ? ast.recur(toType) : ast;
	if ("encodingChecks" in type && type.encodingChecks) {
		const checks = canPreserveEncodingChecks(ast) ? type.encodingChecks : isArrays(type) || isObjects(type) || isDeclaration(type) && type.typeParameters.length > 0 ? extractStructuralChecks(type.encodingChecks) : void 0;
		return copy(type, {
			encodingChecks: void 0,
			checks: combineChecks(type.checks, checks)
		});
	}
	return type;
});
var toEncoded = memoizeIdempotent((ast) => {
	return toType(flip$1(ast));
});
function flipEncoding(ast, encoding) {
	const links = encoding;
	const len = links.length;
	const last = links[len - 1];
	const ls = [new Link(flip$1(replaceEncoding(ast, void 0)), links[0].transformation.flip())];
	for (let i = 1; i < len; i++) ls.unshift(new Link(flip$1(links[i - 1].to), links[i].transformation.flip()));
	const to = flip$1(last.to);
	if (to.encoding) return replaceEncoding(to, [...to.encoding, ...ls]);
	else return replaceEncoding(to, ls);
}
var flip$1 = memoize((ast) => {
	if (ast.encoding) return flipEncoding(ast, ast.encoding);
	const owner = getContextOwner(ast);
	if (owner !== ast) {
		const flipped = flip$1(owner);
		return flipped === owner ? ast : replaceContext(flipped, ast.context);
	}
	return "flip" in ast ? ast.flip(flip$1) : "recur" in ast ? ast.recur(flip$1) : ast;
});
function containsUndefined(ast) {
	switch (ast._tag) {
		case "Undefined": return true;
		case "Union": return ast.types.some(containsUndefined);
		default: return false;
	}
}
function fromConst(ast, value) {
	const succeed$7 = value === 0 ? sameExit : succeed(value);
	return (input, options) => {
		if (input === missing) return missingExit;
		if (input === value) return succeed$7;
		return fail$1(new InvalidType(ast, input, options));
	};
}
function fromRefinement(ast, refinement) {
	return (input, options) => {
		if (input === missing) return missingExit;
		if (refinement(input)) return sameExit;
		return fail$1(new InvalidType(ast, input, options));
	};
}
var parameterFromPropertyKey = applyToSelfOrLastLinkEncodingIdempotent((ast) => {
	switch (ast._tag) {
		default: return ast;
		case "Number": return ast.toCodecStringTree();
		case "Union": return ast.recur(parameterFromPropertyKey);
	}
});
var isStringFiniteRegExp = new globalThis.RegExp(`^${FINITE_PATTERN}$`);
var isStringNumberRegExp = new globalThis.RegExp(`^(?:${FINITE_PATTERN}|Infinity|-Infinity|NaN)$`);
function isStringFinite(annotations) {
	return isPattern$1(isStringFiniteRegExp, {
		expected: "a string representing a finite number",
		representation: {
			id: "effect/schema/isStringFinite",
			payload: null
		},
		toJsonSchema: () => ({ pattern: isStringFiniteRegExp.source }),
		...annotations
	});
}
var finiteString = appendChecks(string, [isStringFinite()]);
var finiteToString = new Link(finiteString, numberFromString);
var numberToString = new Link(new Union$1([finiteString, nonFiniteLiterals]), numberFromString);
function collectIssues(checks, value, issues, ast, options) {
	for (let i = 0; i < checks.length; i++) {
		const check = checks[i];
		if (check._tag === "FilterGroup") {
			issues = collectIssues(check.checks, value, issues, ast, options);
			if (issues && (options.errors !== "all" || issues[issues.length - 1].filter.aborted)) return issues;
		} else {
			const issue = check.run(value, ast, options);
			if (issue) {
				const filter = new Filter$1(check, issue, value, options);
				if (issues) issues.push(filter);
				else issues = [filter];
				if (options.errors !== "all" || check.aborted) return issues;
			}
		}
	}
	return issues;
}
function getConstructorDescriptor(ast) {
	if (!isDeclaration(ast)) return void 0;
	const getDescriptor = ast.annotations?.[CONSTRUCTOR_ANNOTATION_KEY];
	return isFunction(getDescriptor) ? getDescriptor(ast.typeParameters) : void 0;
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/schema/interpreter.js
var flatMapTransformation = (result, current, f) => result === sameExit ? f(current) : flatMapEager(result, f);
function compileTransformation(transformation) {
	if (transformation._tag === "Middleware") return (result, current, options) => {
		return fromOptionalEffect(result === sameExit ? transformation.decode(succeed(toOption(current)), options) : transformation.decode(mapEager(result, toOption), options));
	};
	const getter = transformation.decode;
	switch (getter._tag) {
		case "Passthrough": return (result, current) => result === sameExit ? succeed(current) : result;
		case "Transform": {
			const transform = (value) => value === missing ? missingExit : succeed(getter.transform(value));
			return (result, current) => flatMapTransformation(result, current, transform);
		}
		case "TransformOptional": {
			const transform = (value) => fromOptionExit(getter.transform(toOption(value)));
			return (result, current) => flatMapTransformation(result, current, transform);
		}
		case "TransformEffect": return (result, current, options) => flatMapTransformation(result, current, (value) => value === missing ? missingExit : getter.transform(value, options));
		case "TransformOptionalEffect": return (result, current, options) => flatMapTransformation(result, current, (value) => fromOptionalEffect(getter.transform(toOption(value), options)));
	}
}
var fromOptionalEffect = (effect) => flatMapEager(effect, fromOptionExit);
var wrapEncoding = (ast, input, options, effect) => catchCause(effect, (cause) => failCauseSync(() => map(cause, (issue) => new Encoding(ast, issue, input, options))));
function makeConstructorParser(descriptor, compile) {
	const transform = compileTransformation(descriptor.link.transformation);
	let sourceParser;
	return (input, options) => {
		if (input === missing) return missingExit;
		if (descriptor.isConstructed(input)) return sameExit;
		const result = (sourceParser ??= compile(descriptor.link.to))(input, options);
		return transform(result, input, options);
	};
}
function withDefault(ast, parser) {
	const defaultValue = ast.context.constructorDefault;
	return (input, options) => {
		if (input !== missing && input !== void 0) return parser(input, options);
		const result = defaultValue;
		if (effectIsExit(result) && result._tag === "Success") {
			const local = parser(result[args], options);
			return local === sameExit ? result : local;
		}
		return flatMapEager(wrapEncoding(ast, input, options, result), (value) => {
			const local = parser(value, options);
			return local === sameExit ? succeed(value) : local;
		});
	};
}
function compileField(ast, compile) {
	const parser = compile(ast);
	return ast.context?.constructorDefault === void 0 ? parser : withDefault(ast, parser);
}
function compile(ast, compile, compileField, base, specialize) {
	if (ast._tag === "Declaration") for (const parameter of ast.typeParameters) compile(parameter);
	const descriptor = compileField ? getConstructorDescriptor(ast) : void 0;
	const parser = descriptor ? makeConstructorParser(descriptor, compile) : base ?? ast.getParser(compile, compileField);
	const checks = ast.checks;
	const links = ast.encoding;
	const transformations = links?.map((link) => compileTransformation(link.transformation));
	const encodingChecks = ast.encodingChecks;
	if (!links && !checks && !encodingChecks) return parser;
	let encodingParsers;
	const parseChecks = (input, options) => {
		let result = parser(input, options);
		if (encodingChecks && !options.disableChecks) {
			if (effectIsExit(result)) {
				if (result._tag === "Success") {
					const output = result === sameExit ? input : result[args];
					if (input !== missing && output !== missing) {
						const issues = collectIssues(encodingChecks, input, void 0, ast, options);
						if (issues) result = fail$1(new Composite(ast, issues, input, options));
					}
				}
			} else result = flatMap(result, (value) => {
				if (input !== missing && value !== missing) {
					const issues = collectIssues(encodingChecks, input, void 0, ast, options);
					if (issues) return fail$1(new Composite(ast, issues, input, options));
				}
				return succeed$1(value);
			});
		}
		if (checks && !options.disableChecks) {
			if (effectIsExit(result)) {
				if (result._tag === "Success") {
					const value = result === sameExit ? input : result[args];
					if (value === missing) return result;
					const issues = collectIssues(checks, value, void 0, ast, options);
					if (issues) result = fail$1(new Composite(ast, issues, value, options));
				}
			} else result = flatMap(result, (value) => {
				if (value !== missing) {
					const issues = collectIssues(checks, value, void 0, ast, options);
					if (issues) return fail$1(new Composite(ast, issues, value, options));
				}
				return succeed$1(value);
			});
		}
		return result;
	};
	const parseLocal = specialize === void 0 ? parseChecks : specialize(parseChecks);
	if (!links) return parseLocal;
	return (input, options) => {
		const parsers = encodingParsers ??= links.map((link) => compile(link.to));
		let current = input;
		let result = parsers[parsers.length - 1](input, options);
		for (let i = links.length - 1; i >= 0; i--) {
			result = transformations[i](result, current, options);
			if (i !== 0) {
				const next = parsers[i - 1];
				if (result._tag === "Success") {
					current = result[args];
					result = next(current, options);
				} else result = flatMapEager(result, (value) => {
					const nextResult = next(value, options);
					return nextResult === sameExit ? succeed(value) : nextResult;
				});
			}
		}
		if (result._tag === "Success") {
			const value = result[args];
			const local = parseLocal(value, options);
			return local === sameExit ? result : local;
		}
		result = wrapEncoding(ast, input, options, result);
		return flatMapEager(result, (value) => {
			const local = parseLocal(value, options);
			return local === sameExit ? succeed(value) : local;
		});
	};
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/schema/compilerRegistry.js
var invalid = Symbol();
var cache = new WeakMap();
var compilerAdaptersEnabled = false;
var decodeChild = (ast) => compilerAdaptersEnabled ? lazyParser(resolve, ast, "parser") : resolve(ast).parser;
var makeChild = (ast) => compilerAdaptersEnabled ? lazyParser(resolve, ast, "makeEffect") : resolve(ast).makeEffect;
var makeField = (ast) => compileField(ast, makeChild);
var InterpretedEntry = class {
	ast;
	constructor(ast) {
		this.ast = ast;
	}
	get decodeEffect() {
		return this.cachedDecodeEffect ??= compile(this.ast, decodeChild);
	}
	get parser() {
		return this.decodeEffect;
	}
	get makeEffect() {
		return this.cachedMakeEffect ??= compile(this.ast, makeChild, makeField);
	}
};
function lazyParser(resolve, ast, operation) {
	const entry = resolve(ast);
	if (entry.compiled === void 0 || Object.hasOwn(entry, operation)) return entry[operation];
	let parser;
	return (input, options) => (parser ??= entry[operation])(input, options);
}
function resolve(ast) {
	const cached = cache.get(ast);
	if (cached !== void 0) return cached;
	const entry = new InterpretedEntry(ast);
	cache.set(ast, entry);
	return entry;
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/SchemaParser.js
function makeEffect(schema) {
	const ast = schema.ast;
	let parser;
	return (input, options) => {
		return (parser ??= runWithCompiler(constructorCompiler, toType(ast)))(input, options?.disableChecks ? options?.parseOptions ? {
			...options.parseOptions,
			disableChecks: true
		} : { disableChecks: true } : options?.parseOptions);
	};
}
function makeOption(schema) {
	const parser = makeEffect(schema);
	return (input, options) => {
		const exit = runSyncExit(parser(input, options));
		if (isSuccess(exit)) return some(exit.value);
		getSchemaIssueOrThrow(exit.cause, "Option adapter can only return none for schema issues");
		return none();
	};
}
function make$2(schema) {
	return makeConstructorSync(toType(schema.ast));
}
function decodeUnknownEffect$1(schema, options) {
	const parser = run(schema.ast);
	return options === void 0 ? parser : (input, overrideOptions) => parser(input, mergeParseOptions(options, overrideOptions));
}
function decodeUnknownResult(schema, options) {
	return asResult(decodeUnknownEffect$1(schema, options));
}
function encodeUnknownEffect$1(schema, options) {
	const parser = run(flip$1(schema.ast));
	return options === void 0 ? parser : (input, overrideOptions) => parser(input, mergeParseOptions(options, overrideOptions));
}
var mergeParseOptions = (options, overrideOptions) => overrideOptions ? {
	...options,
	...overrideOptions
} : options;
var getValue = (value) => {
	if (value === missing) return fail$1(new InvalidValue());
	return succeed$1(value);
};
function run(ast) {
	return runWithCompiler(normalCompiler, ast);
}
function parserResult(result, input) {
	if (result === sameExit) return succeed$1(input);
	if (!effectIsExit(result)) return flatMapEager(result, getValue);
	return result[args] === missing ? getValue(missing) : result;
}
function runWithCompiler(compiler, ast) {
	let parser;
	return (input, options) => {
		const result = (parser ??= compiler(ast))(input, options ?? defaultParseOptions);
		if (result === sameExit) return succeed$1(input);
		if (!effectIsExit(result)) return flatMapEager(result, getValue);
		return result[args] === missing ? getValue(missing) : result;
	};
}
function asExit(parser) {
	return (input, options) => runSyncExit(parser(input, options));
}
function asResult(parser) {
	const parserExit = asExit(parser);
	return (input, options) => {
		const exit = parserExit(input, options);
		if (isSuccess(exit)) return succeed$4(exit.value);
		return fail$4(getSchemaIssueOrThrow(exit.cause, "Result adapter can only return schema issues"));
	};
}
function runSync(effect, message) {
	const exit = runSyncExit(effect);
	if (isSuccess(exit)) return exit.value;
	const issue = getSchemaIssueOrThrow(exit.cause, message);
	throw new Error("Schema validation failed", { cause: issue });
}
function makeConstructorSync(ast) {
	let entry;
	let parser;
	return (input, options) => {
		entry ??= resolve(ast);
		const parseOptions = options?.disableChecks ? options.parseOptions ? {
			...options.parseOptions,
			disableChecks: true
		} : { disableChecks: true } : options?.parseOptions ?? defaultParseOptions;
		const make = entry.make;
		if (make !== void 0 && input !== missing) {
			let output;
			try {
				output = make(input, parseOptions);
			} catch (error) {
				getSchemaIssueOrThrow(die$1(error), "Constructor adapter can only throw schema issues");
				throw error;
			}
			if (output !== invalid && output !== missing) return output;
		}
		return runSync(parserResult((parser ??= entry.makeEffect)(input, parseOptions), input), "Constructor adapter can only throw schema issues");
	};
}
var normalCompiler = (ast) => resolve(ast).parser;
var constructorCompiler = (ast) => resolve(ast).makeEffect;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/schema/make.js
var TypeId = "~effect/Schema/Schema";
var RebuildOptions = Symbol();
var SchemaProto = {
	[TypeId]: TypeId,
	get make() {
		const value = make$2(this);
		Object.defineProperty(this, "make", {
			value,
			enumerable: true
		});
		return value;
	},
	get makeEffect() {
		const value = makeEffect(this);
		Object.defineProperty(this, "makeEffect", {
			value,
			enumerable: true
		});
		return value;
	},
	get makeOption() {
		const value = makeOption(this);
		Object.defineProperty(this, "makeOption", {
			value,
			enumerable: true
		});
		return value;
	},
	pipe() {
		return pipeArguments(this, arguments);
	},
	annotate(annotations) {
		return this.rebuild(annotate(this.ast, annotations));
	},
	annotateKey(annotations) {
		return this.rebuild(annotateKey(this.ast, annotations));
	},
	check(...checks) {
		return this.rebuild(appendChecks(this.ast, checks));
	},
	rebuild(ast) {
		return make$1(ast, this[RebuildOptions]);
	}
};
function make$1(ast, options) {
	function Schema() {}
	const self = Object.setPrototypeOf(Schema, SchemaProto);
	if (options && (Object.hasOwn(options, "name") || Object.hasOwn(options, "length") || Object.hasOwn(options, "__proto__"))) Object.defineProperties(self, Object.getOwnPropertyDescriptors({ ...options }));
	else Object.assign(self, options);
	self[RebuildOptions] = options;
	self.ast = ast;
	return self;
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Struct.js
var lambda = (f) => f;
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/internal/schemaError.js
var SchemaErrorTypeId = "~effect/Schema/SchemaError";
function isSchemaError$1(u) {
	return hasProperty(u, "~effect/Schema/SchemaError") && u["~effect/Schema/SchemaError"] === "~effect/Schema/SchemaError";
}
//#endregion
//#region ../../node_modules/.pnpm/effect@4.0.1/node_modules/effect/dist/Schema.js
function declareConstructor() {
	return (typeParameters, run, annotations) => {
		return make(new Declaration(typeParameters.map(getAST), (typeParameters) => run(typeParameters.map((ast) => make(ast))), annotations));
	};
}
function declare(is, annotations) {
	return declareConstructor()([], () => (input, ast, options) => is(input) ? succeed$1(input) : fail$1(new InvalidType(ast, input, options)), annotations);
}
function annotateEncoded(annotations) {
	return (self) => flip(flip(self).annotate(annotations));
}
var SchemaError = class extends TaggedError("SchemaError") {
	[SchemaErrorTypeId] = SchemaErrorTypeId;
	constructor(issue) {
		const stackTraceLimit = getStackTraceLimit();
		setStackTraceLimit(0);
		try {
			super({ issue });
		} finally {
			setStackTraceLimit(stackTraceLimit);
		}
	}
	get message() {
		return defaultFormatter(this.issue);
	}
	toString() {
		return `SchemaError(${this.message})`;
	}
};
function isSchemaError(u) {
	return isSchemaError$1(u);
}
function fromIssueEffect(self) {
	if (effectIsExit(self)) return fromIssueExit(self);
	return catchCause(self, (cause) => failCauseSync(() => map(cause, (issue) => new SchemaError(issue))));
}
function fromIssueExit(exit) {
	return isSuccess(exit) ? exit : failCause(map(exit.cause, (issue) => new SchemaError(issue)));
}
function getSchemaErrorOrThrow(cause, message) {
	let schemaError;
	for (const reason of cause.reasons) {
		if (!isFailReason(reason) || !isSchemaError(reason.error)) throw new globalThis.Error(message, { cause });
		schemaError ??= reason.error;
	}
	if (schemaError === void 0) throw new globalThis.Error(message, { cause });
	return schemaError;
}
function runSchemaErrorSync(self) {
	const exit = runSyncExit(self);
	if (isSuccess(exit)) return exit.value;
	throw getSchemaErrorOrThrow(exit.cause, "Sync adapter can only throw schema errors");
}
function decodeUnknownEffect(schema, options) {
	const parser = decodeUnknownEffect$1(schema, options);
	return (input, options) => {
		return fromIssueEffect(parser(input, options));
	};
}
function decodeUnknownSync(schema, options) {
	const parser = decodeUnknownEffect(schema, options);
	return (input, options) => {
		return runSchemaErrorSync(parser(input, options));
	};
}
function encodeUnknownEffect(schema, options) {
	const parser = encodeUnknownEffect$1(schema, options);
	return (input, options) => {
		return fromIssueEffect(parser(input, options));
	};
}
function encodeUnknownSync(schema, options) {
	const parser = encodeUnknownEffect(schema, options);
	return (input, options) => {
		return runSchemaErrorSync(parser(input, options));
	};
}
var encodeSync = encodeUnknownSync;
var make = make$1;
var FlipTypeId = "~effect/Schema/flip";
function isFlip$(schema) {
	return hasProperty(schema, FlipTypeId) && schema[FlipTypeId] === FlipTypeId;
}
function flip(schema) {
	if (isFlip$(schema)) return schema.schema.rebuild(flip$1(schema.ast));
	return make(flip$1(schema.ast), {
		[FlipTypeId]: FlipTypeId,
		schema
	});
}
function Literal(literal) {
	const out = make(new Literal$1(literal), {
		literal,
		transform(to) {
			return out.pipe(decodeTo(Literal(to), {
				decode: transform$1(() => to),
				encode: transform$1(() => literal)
			}));
		}
	});
	return out;
}
var Null = make(null_);
var String$1 = make(string);
var Number$1 = make(number);
var Boolean = make(boolean);
function makeStruct(ast, fields) {
	return make(ast, {
		fields,
		mapFields(f, options) {
			const fields = f(this.fields);
			return makeStruct(struct(fields, options?.unsafePreserveChecks ? this.ast.checks : void 0), fields);
		}
	});
}
function Struct(fields) {
	return makeStruct(struct(fields, void 0), fields);
}
var ArraySchema = lambda((schema) => make(new Arrays(false, [], [schema.ast]), { value: schema }));
function makeUnion(ast, members) {
	return make(ast, {
		members,
		mapMembers(f, options) {
			const members = f(this.members);
			return makeUnion(union(members, this.ast.options, options?.unsafePreserveChecks ? this.ast.checks : void 0), members);
		}
	});
}
function Union(members, options) {
	return makeUnion(union(members, options, void 0), members);
}
function Literals(literals) {
	const members = literals.map(Literal);
	return make(union(members, void 0, void 0), {
		literals,
		members,
		mapMembers(f) {
			return Union(f(this.members));
		},
		pick(literals) {
			return Literals(literals);
		},
		transform(to) {
			return Union(members.map((member, index) => member.transform(to[index])));
		}
	});
}
var NullOr = lambda((self) => Union([self, Null]));
function brand(identifier) {
	return (schema) => make(schema.ast, {
		schema,
		identifier
	});
}
function decodeTo(to, transformation) {
	return (from) => {
		return make(decodeTo$1(from.ast, to.ast, transformation ? makeTransformation(transformation) : passthrough()), {
			from,
			to
		});
	};
}
function linkDecoding() {
	return (to, decode) => link()(to, {
		decode,
		encode: forbiddenEncoding
	});
}
function link() {
	return (encodeTo, transformation) => {
		return new Link(encodeTo.ast, makeTransformation(transformation));
	};
}
var makeFilter = makeFilter$1;
function makeIsBetween(deriveOptions) {
	const greaterThanOrEqualTo = isGreaterThanOrEqualTo$1(deriveOptions.order);
	const greaterThan = isGreaterThan$1(deriveOptions.order);
	const lessThanOrEqualTo = isLessThanOrEqualTo$1(deriveOptions.order);
	const lessThan = isLessThan$1(deriveOptions.order);
	const formatter = deriveOptions.formatter ?? format$1;
	return (options, annotations) => {
		const gte = options.exclusiveMinimum ? greaterThan : greaterThanOrEqualTo;
		const lte = options.exclusiveMaximum ? lessThan : lessThanOrEqualTo;
		return makeFilter((input) => gte(input, options.minimum) && lte(input, options.maximum), {
			expected: `a value between ${formatter(options.minimum)}${options.exclusiveMinimum ? " (excluded)" : ""} and ${formatter(options.maximum)}${options.exclusiveMaximum ? " (excluded)" : ""}`,
			arbitraryConstraint: {
				order: deriveOptions.order,
				minimum: options.minimum,
				maximum: options.maximum,
				...options.exclusiveMinimum && { exclusiveMinimum: true },
				...options.exclusiveMaximum && { exclusiveMaximum: true }
			},
			...deriveOptions.annotate?.(options),
			...annotations
		});
	};
}
function encodeNumberPayload(number) {
	if (!globalThis.Number.isFinite(number)) throw new globalThis.RangeError(`Expected a finite number, got ${format$1(number)}`);
	return number;
}
var isBetween = makeIsBetween({
	order: Number$4,
	annotate: (options) => {
		const exclusiveMinimum = options.exclusiveMinimum ? true : void 0;
		const exclusiveMaximum = options.exclusiveMaximum ? true : void 0;
		return {
			representation: {
				id: "effect/schema/isBetween",
				payload: {
					minimum: encodeNumberPayload(options.minimum),
					maximum: encodeNumberPayload(options.maximum),
					...exclusiveMinimum && { exclusiveMinimum },
					...exclusiveMaximum && { exclusiveMaximum }
				}
			},
			toJsonSchema: () => ({
				[exclusiveMinimum ? "exclusiveMinimum" : "minimum"]: options.minimum,
				[exclusiveMaximum ? "exclusiveMaximum" : "maximum"]: options.maximum
			}),
			toCode: () => ({ runtime: `Schema.isBetween({ minimum: ${format$1(options.minimum)}, maximum: ${format$1(options.maximum)}, exclusiveMinimum: ${format$1(exclusiveMinimum)}, exclusiveMaximum: ${format$1(exclusiveMaximum)} })` })
		};
	}
});
function isInt(annotations) {
	return makeFilter((n) => globalThis.Number.isSafeInteger(n), {
		expected: "an integer",
		representation: {
			id: "effect/schema/isInt",
			payload: null
		},
		toJsonSchema: () => [{ type: "integer" }, true],
		toCode: () => ({ runtime: "Schema.isInt()" }),
		arbitraryConstraint: { number: "integer" },
		...annotations
	});
}
var Int = Number$1.check(isInt());
function isMinLength(minLength, annotations) {
	minLength = normalizeCardinality(minLength);
	return makeIsMinLength(minLength, Math.ceil(minLength / 2), annotations);
}
function makeIsMinLength(minLength, minCodePoints, annotations) {
	return makeFilter((input) => input.length >= minLength, {
		expected: `a value with a length of at least ${minLength}`,
		representation: {
			id: "effect/schema/isMinLength",
			payload: { minLength }
		},
		toJsonSchema: ({ type }) => type === "string" ? minLength <= 1 ? { minLength: minCodePoints } : [{ minLength: minCodePoints }, true] : type === "array" ? { minItems: minLength } : type === void 0 ? [{
			minLength: minCodePoints,
			minItems: minLength
		}, true] : [{}, true],
		toCode: () => ({ runtime: `Schema.isMinLength(${minLength})` }),
		[STRUCTURAL_ANNOTATION_KEY]: true,
		arbitraryConstraint: { minLength },
		...annotations
	});
}
function isNonEmpty(annotations) {
	return makeIsMinLength(1, 1, annotations);
}
function normalizeCardinality(value) {
	if (!globalThis.Number.isFinite(value)) throw new globalThis.RangeError(`Expected a finite number, got ${value}`);
	return Math.max(0, Math.floor(value));
}
var NonEmptyString = String$1.check(isNonEmpty());
globalThis.RegExp;
globalThis.URL;
globalThis.File;
globalThis.FormData;
globalThis.URLSearchParams;
globalThis.Uint8Array;
var dateTimeUtcFromString = transformEffect({
	decode: (s, options) => {
		return match$2(make$4(s), {
			onNone: () => fail$1(new InvalidValue({ expected: "a valid UTC DateTime string" }, s, options)),
			onSome: (result) => succeed$1(toUtc(result))
		});
	},
	encode: (utc) => succeed$1(formatIso(utc))
});
var arbitraryMinimumDateTimestamp = -864e13;
var arbitraryMaximumDateTimestamp = 864e13;
function dateTimeArbitraryBounds(constraint, domainMinimum, domainMaximum) {
	const minimum = Math.max(domainMinimum, constraint?.minimum === void 0 ? domainMinimum : constraint.minimum.epochMilliseconds + (constraint.exclusiveMinimum === true ? 1 : 0));
	const maximum = Math.min(domainMaximum, constraint?.maximum === void 0 ? domainMaximum : constraint.maximum.epochMilliseconds - (constraint.exclusiveMaximum === true ? 1 : 0));
	return minimum <= maximum ? [minimum, maximum] : [domainMinimum, domainMaximum];
}
function dateTimeArbitraryInteger(minimum, maximum) {
	return Int.check(isBetween({
		minimum,
		maximum
	}));
}
var DateTimeUtc = declare((u) => isDateTime(u) && isUtc(u), {
	representation: {
		id: "effect/schema/DateTimeUtc",
		payload: null
	},
	toCode: () => ({
		runtime: `Schema.DateTimeUtc`,
		Type: `DateTime.Utc`,
		importDeclarations: [`import * as DateTime from "effect/DateTime"`]
	}),
	expected: "DateTime.Utc",
	toCodecArbitrary: ({ constraint }) => {
		const [minimum, maximum] = dateTimeArbitraryBounds(constraint, arbitraryMinimumDateTimestamp, arbitraryMaximumDateTimestamp);
		return linkDecoding()(dateTimeArbitraryInteger(minimum, maximum), transform$1(makeUnsafe));
	},
	toCodecJson: () => link()(String$1, dateTimeUtcFromString),
	toFormatter: () => (utc) => utc.toString()
});
var DateTimeUtcFromString = String$1.annotate({ expected: "a string that will be decoded as a DateTime.Utc" }).pipe(decodeTo(DateTimeUtc, dateTimeUtcFromString));
//#endregion
//#region src/engine/money.ts
var USDCents = Int.check(isBetween({
	maximum: Number.MAX_SAFE_INTEGER,
	minimum: 0
})).pipe(brand("USDCents")).annotate({ description: "Whole US cents, a nonnegative safe integer" });
var Percent = Int.check(isBetween({
	maximum: 100,
	minimum: 0
})).annotate({ description: "Whole percent off, 0 to 100" });
var Quantity = Int.check(isBetween({
	maximum: 1e4,
	minimum: 1
})).pipe(brand("Quantity")).annotate({ description: "Seats in one order, 1 to 10,000" });
var Instant = DateTimeUtcFromString.annotate({ description: "Exact UTC instant" });
var percentOff = (list, percent) => USDCents.make(Math.floor(list * (100 - percent) / 100));
var minus = (amount, credit) => USDCents.make(Math.max(0, amount - credit));
//#endregion
//#region src/engine/facts.ts
var SourceRef$1 = NonEmptyString.annotate({ description: "Evidence reference for a fact, never customer text" });
var FactGap = Literals([
	"FactsUnavailable",
	"IdentityUnverified",
	"PaymentAmbiguous"
]);
var fact = (value) => Union([Struct({
	sourceRefs: ArraySchema(SourceRef$1),
	value
}), Struct({ gap: FactGap })]);
var isKnown = (value) => "value" in value;
var BindingQuote = Struct({
	amount: USDCents,
	basis: Literals([
		"Unit",
		"Total",
		"Unknown"
	]).annotate({ description: "Unit: amount is per seat. Total: amount is the whole order. Unknown never binds" }),
	currency: NonEmptyString.annotate({ description: "ISO currency of amount; only USD binds" }),
	expiresAt: NullOr(Instant).annotate({ description: "Inclusive expiry instant; null means no deadline" }),
	product: NonEmptyString.annotate({ description: "Policy product the quote is for" }),
	quantity: NullOr(Quantity).annotate({ description: "Quoted seats; null means unknown, never one" }),
	ref: NonEmptyString.annotate({ description: "Quote reference quoteId@revision#lineId, never message text" })
});
//#endregion
//#region src/engine/decode.ts
var formatter = makeFormatterStandardSchemaV1();
var issuesOf = (issue) => formatter(issue).issues.map(({ message, path }) => ({
	message,
	path: (path ?? []).map(String)
}));
var decoderOf = (schema) => flow(decodeUnknownResult(schema), match$1({
	onFailure: (issue) => ({
		issues: issuesOf(issue),
		ok: false
	}),
	onSuccess: (value) => ({
		ok: true,
		value
	})
}));
var plainDecoderOf = (schema) => {
	const encode = encodeSync(schema);
	return flow(decoderOf(schema), (decoded) => decoded.ok ? {
		ok: true,
		value: encode(decoded.value)
	} : decoded);
};
decoderOf(ArraySchema(BindingQuote));
//#endregion
//#region src/engine/result.ts
var ENGINE_VERSION$1 = "0.1.0";
var Reason = Struct({
	code: Literals([
		"policy-disabled",
		"policy-unresolved",
		"merchant-price-mismatch",
		"not-open",
		"checkout-stopped",
		"enrollment-closed",
		"fact-unknown",
		"credit-amount-unrecognized",
		"credit-spent",
		"individual-quantity",
		"quote-basis-unknown",
		"quote-expired",
		"quote-out-of-scope",
		"early-window",
		"standard-window",
		"selected"
	]).annotate({ description: "Why the engine decided this" }),
	detail: String$1.annotate({ description: "The field, ruling, amount or quote ref behind the code" })
});
var reason = (code, detail = "") => ({
	code,
	detail
});
var Basis = Literals([
	"formula",
	"ppp",
	"team",
	"quote"
]);
var Restriction = Literals(["none", "region"]);
var Consent = Literal("region");
var Candidate = Struct({
	amount: USDCents.annotate({ description: "Order subtotal in US cents after discounts, before tax" }),
	basis: Basis.annotate({ description: "Formula, PPP, team band or binding quote" }),
	consent: NullOr(Consent).annotate({ description: "The buyer consent this price needs before it may compete; null when it needs none" }),
	creditSource: NullOr(String$1).annotate({ description: "The purchase whose Crash Course credit this spends, or null" }),
	quoteRefs: ArraySchema(String$1).annotate({ description: "Binding quote lines this candidate honours" }),
	restriction: Restriction.annotate({ description: "Region when the price needs PPP's region restriction" }),
	rule: String$1.annotate({ description: "The rule, named by its rule set, that offered this price" }),
	unitAmount: NullOr(USDCents).annotate({ description: "Null when a Total quote does not divide into whole cents" })
});
var reasons = ArraySchema(Reason).annotate({ description: "Every reason behind the result, in a stable order" });
var refusal = (kind) => Struct({
	kind: Literal(kind).annotate({ description: "No price: not open yet, closed, or held for a person" }),
	reasons
});
var pricingResultOf = (unresolved, acceptedFact) => {
	const pricedFields = {
		...Candidate.fields,
		acceptedFacts: ArraySchema(acceptedFact).annotate({ description: "Every buyer fact the engine accepted, by field name, with only its product refs; gaps are absent" }),
		candidates: ArraySchema(Candidate).annotate({ description: "Every candidate considered, cheapest first" }),
		engineVersion: String$1.annotate({ description: "The pricing engine version that priced it" }),
		offers: ArraySchema(Candidate).annotate({ description: "Prices strictly cheaper than this one that need a consent the buyer has not given, cheapest first" }),
		policyVersion: String$1.annotate({ description: "The policy version that priced it" }),
		reasons
	};
	return Union([
		Struct({
			...pricedFields,
			kind: Literal("priced").annotate({ description: "A price the buyer may pay" })
		}),
		Struct({
			...pricedFields,
			kind: Literal("bounded").annotate({ description: "An upper bound, never a checkout price: unknown buyer facts could only lower it" }),
			unresolved: ArraySchema(unresolved).annotate({ description: "Each discount still open and the fact that would decide it" })
		}),
		refusal("not-open"),
		refusal("closed"),
		refusal("held")
	]);
};
//#endregion
//#region src/rules/c5/policy.ts
var SourceRef = NonEmptyString.annotate({ description: "Where a ruling or fact comes from, never customer text" });
var ruling = (description, value) => Union([Struct({
	source: SourceRef,
	value: value.pipe(annotateEncoded({ description }))
}), Struct({ question: NonEmptyString.annotate({ description: "The open question that blocks pricing until Joel rules" }) })]).annotate({ description: `${description}: a ruling with its source, or the open question that holds it` });
var isRuled = (entry) => "value" in entry;
var TeamBand = Struct({
	minSeats: Quantity,
	percent: Percent
});
var ascendingFromOne = (bands) => bands[0]?.minSeats === 1 && bands.every((band, index) => index === 0 || band.minSeats > (bands[index - 1]?.minSeats ?? 0));
var teamBands = (description) => ArraySchema(TeamBand).annotate({ description }).check(makeFilter(ascendingFromOne, { expected: "bands starting at one seat, strictly ascending" }));
var ProductId = NonEmptyString.annotate({ description: "An AI Hero product id" });
var distinct = (ids) => new Set(ids).size === ids.length;
var LegendManifest = Struct({
	excludes: ArraySchema(ProductId).annotate({ description: "Products that never count toward legend" }),
	ownership: Literal("own-purchases").annotate({ description: "Only the buyer's own purchases count; team seats and bulk redemptions do not" }),
	products: ArraySchema(ProductId).annotate({ description: "A legend owns every one of these products" }).check(isMinLength(1)).check(makeFilter(distinct, { expected: "distinct product ids" })),
	statuses: ArraySchema(Literals(["Valid", "Restricted"])).annotate({ description: "Purchase statuses that count as owning a product" }),
	version: NonEmptyString.annotate({ description: "Manifest version a legend fact must have been checked against" })
});
var LEGEND_PRODUCT_REF = "product:";
var PricingPolicy = Struct({
	alumniPercent: ruling("Percent off list for a returning cohort alumnus", Percent),
	checkoutStopsAt: ruling("Instant checkout stops selling", Instant),
	closesAt: ruling("Instant the cohort closes", Instant),
	creditAmounts: ruling("Crash Course credit amounts a buyer may apply, in US cents", ArraySchema(USDCents)),
	earlyEndsAt: ruling("Instant the early phase ends", Instant),
	enabled: Boolean.annotate({ description: "Whether this policy prices anything at all" }),
	legend: ruling("Legend terms for a buyer who owns every manifest product", Struct({
		credit: USDCents,
		manifest: LegendManifest.annotate({ description: "Which purchases make a buyer a legend" }),
		percent: Percent
	})),
	list: USDCents,
	newBuyerEarlyPercent: ruling("Percent off list for a new buyer in the early phase", Percent),
	opensAt: ruling("Instant sales open; null means already open", NullOr(Instant)),
	ppp: ruling("How purchasing-power parity combines with the formula price", Literal("better-of-formula-or-ppp")),
	product: NonEmptyString.annotate({ description: "The product this policy prices" }),
	teamBands: ruling("Team seat bands, early and standard", Struct({
		early: teamBands("Bands in the early phase"),
		standard: teamBands("Bands after the early phase")
	})),
	version: NonEmptyString.annotate({ description: "Policy version; it changes whenever any rule changes" })
});
decodeUnknownSync(PricingPolicy);
decoderOf(PricingPolicy);
//#endregion
//#region src/rules/c5/facts.ts
var Credit = NullOr(Struct({
	paid: USDCents.annotate({ description: "Product money actually paid, never tax or presentment" }),
	source: NonEmptyString.annotate({ description: "The one qualifying purchase this credit would spend" })
})).annotate({ description: "Null when no qualifying Crash Course credit" });
var PPPChoice = NullOr(Struct({
	accepted: Boolean.annotate({ description: "Explicit consent to the region restriction" }),
	percent: Percent
})).annotate({ description: "Null when the buyer is not PPP eligible" });
var BuyerFacts = Struct({
	alumni: fact(Literals([
		"none",
		"c3",
		"c4",
		"both"
	])),
	credit: fact(Credit),
	creditUse: fact(Literals([
		"available",
		"reserved-by-this-attempt",
		"spent"
	])),
	existingSeats: fact(Int.check(isBetween({
		maximum: 1e5,
		minimum: 0
	}))),
	legend: fact(Literals(["no", "verified"])),
	order: fact(Literals(["individual", "team"])),
	ppp: fact(PPPChoice)
});
var Product = Struct({
	id: NonEmptyString,
	merchantUnit: USDCents.annotate({ description: "Authoritative retail merchant unit price" }),
	policy: PricingPolicy
});
//#endregion
//#region src/engine/price.ts
var QUOTE_RULE = "quote";
var byText = (left, right) => left < right ? -1 : Number(left > right);
var compareBy = (rank) => (left, right) => left.amount - right.amount || Number(left.restriction !== "none") - Number(right.restriction !== "none") || Number(left.creditSource !== null) - Number(right.creditSource !== null) || rank.indexOf(left.rule) - rank.indexOf(right.rule) || left.quoteRefs.join(",").localeCompare(right.quoteRefs.join(",")) || byText(left.rule, right.rule) || byText(left.basis, right.basis) || byText(left.creditSource ?? "", right.creditSource ?? "") || (left.unitAmount ?? -1) - (right.unitAmount ?? -1) || byText(left.consent ?? "", right.consent ?? "") || byText(left.quoteRefs.join("\n"), right.quoteRefs.join("\n"));
var pricer = (rules, rank) => (input, consented, quotes) => {
	const compare = compareBy(rank);
	const offered = [...rules.flatMap((rule) => rule.candidates(input)), ...quotes];
	const open = (candidate) => candidate.consent === null || consented(candidate.consent);
	const candidates = offered.filter(open).toSorted(compare);
	const [chosen] = candidates;
	return {
		candidates,
		chosen,
		offers: chosen === void 0 ? [] : offered.filter((candidate) => !open(candidate) && candidate.amount < chosen.amount).toSorted(compare)
	};
};
var closure = (window, at) => {
	if (window.opensAt !== null && at < toEpochMillis(window.opensAt)) return {
		kind: "not-open",
		reasons: [reason("not-open")]
	};
	if (at >= toEpochMillis(window.closesAt)) return {
		kind: "closed",
		reasons: [reason("enrollment-closed")]
	};
	if (at >= toEpochMillis(window.checkoutStopsAt)) return {
		kind: "closed",
		reasons: [reason("checkout-stopped")]
	};
	return null;
};
var quoteOutcome = (quote, product, quantity, now) => {
	if (quote.product !== product || quote.currency !== "USD") return reason("quote-out-of-scope", quote.ref);
	if (quote.expiresAt !== null && toEpochMillis(now) > toEpochMillis(quote.expiresAt)) return reason("quote-expired", quote.ref);
	if (quote.basis === "Unknown" || quote.quantity === null) return reason("quote-basis-unknown", quote.ref);
	if (quote.quantity !== quantity) return reason("quote-out-of-scope", quote.ref);
	const amount = quote.basis === "Unit" ? USDCents.make(quote.amount * quantity) : quote.amount;
	return {
		amount,
		basis: "quote",
		consent: null,
		creditSource: null,
		quoteRefs: [quote.ref],
		restriction: "none",
		rule: QUOTE_RULE,
		unitAmount: amount % quantity === 0 ? USDCents.make(amount / quantity) : null
	};
};
//#endregion
//#region src/rules/c5/price.ts
var cohort005Rank = [
	"team",
	"legend",
	"alumni",
	"new",
	"ppp",
	QUOTE_RULE
];
var formula = (rule, base, credit) => {
	const amount = minus(base, credit?.paid ?? 0);
	return {
		amount,
		basis: "formula",
		consent: null,
		creditSource: credit?.source ?? null,
		quoteRefs: [],
		restriction: "none",
		rule,
		unitAmount: amount
	};
};
var bandFor = (bands, seats) => bands.findLast((band) => band.minSeats <= seats);
var cohort005Rules = [
	{
		candidates: ({ buyer, phase, quantity, terms }) => {
			const band = bandFor(terms.teamBands[phase], buyer.seats);
			if (band === void 0) return [];
			const unitAmount = percentOff(terms.list, band.percent);
			return [{
				amount: USDCents.make(unitAmount * quantity),
				basis: "team",
				consent: null,
				creditSource: null,
				quoteRefs: [],
				restriction: "none",
				rule: "team",
				unitAmount
			}];
		},
		id: "team",
		order: "team"
	},
	{
		candidates: ({ buyer, phase, terms }) => [formula("new", percentOff(terms.list, phase === "early" ? terms.newBuyerEarlyPercent : 0), buyer.credit)],
		id: "new",
		order: "individual"
	},
	{
		candidates: ({ buyer, terms }) => buyer.alumni ? [formula("alumni", percentOff(terms.list, terms.alumniPercent), buyer.credit)] : [],
		id: "alumni",
		order: "individual"
	},
	{
		candidates: ({ buyer, terms }) => buyer.legend ? [formula("legend", minus(percentOff(terms.list, terms.legend.percent), terms.legend.credit), null)] : [],
		id: "legend",
		order: "individual"
	},
	{
		candidates: ({ buyer, terms }) => {
			if (buyer.ppp === null) return [];
			const amount = percentOff(terms.list, buyer.ppp.percent);
			return [{
				amount,
				basis: "ppp",
				consent: "region",
				creditSource: null,
				quoteRefs: [],
				restriction: "region",
				rule: "ppp",
				unitAmount: amount
			}];
		},
		id: "ppp",
		order: "individual"
	}
];
var resolveTerms = (policy) => {
	const { alumniPercent, checkoutStopsAt, closesAt, creditAmounts, earlyEndsAt, legend, newBuyerEarlyPercent, opensAt, ppp, teamBands } = policy;
	if (isRuled(alumniPercent) && isRuled(checkoutStopsAt) && isRuled(closesAt) && isRuled(creditAmounts) && isRuled(earlyEndsAt) && isRuled(legend) && isRuled(newBuyerEarlyPercent) && isRuled(opensAt) && isRuled(ppp) && isRuled(teamBands)) return { resolved: {
		alumniPercent: alumniPercent.value,
		checkoutStopsAt: checkoutStopsAt.value,
		closesAt: closesAt.value,
		creditAmounts: creditAmounts.value,
		earlyEndsAt: earlyEndsAt.value,
		legend: legend.value,
		list: policy.list,
		newBuyerEarlyPercent: newBuyerEarlyPercent.value,
		opensAt: opensAt.value,
		teamBands: teamBands.value
	} };
	return { held: Object.entries({
		alumniPercent,
		checkoutStopsAt,
		closesAt,
		creditAmounts,
		earlyEndsAt,
		legend,
		newBuyerEarlyPercent,
		opensAt,
		ppp,
		teamBands
	}).flatMap(([field, ruling]) => "question" in ruling ? [reason("policy-unresolved", `${field}: ${ruling.question}`)] : []) };
};
var gaps = (facts) => Object.entries(facts).flatMap(([field, fact]) => "gap" in fact ? [reason("fact-unknown", `${field}: ${fact.gap}`)] : []);
var teamBuyer = (seats) => ({
	alumni: false,
	credit: null,
	legend: false,
	order: "team",
	ppp: null,
	seats
});
var INDIVIDUAL_FACTS = [
	"alumni",
	"credit",
	"creditUse",
	"legend",
	"ppp"
];
var UNLOCKS = {
	alumni: "alumni",
	credit: "credit",
	creditUse: "credit",
	legend: "legend",
	ppp: "ppp"
};
var needs = (field, terms) => ({
	alumni: "C3 or C4 purchase history",
	credit: "the settled Crash Course payment",
	creditUse: "whether the Crash Course credit is already spent",
	legend: `ownership checked against legend manifest ${terms.legend.manifest.version}`,
	ppp: "buyer country and consent"
})[field];
var checkedProducts = (sourceRefs) => new Set(sourceRefs.flatMap((ref) => ref.startsWith("product:") ? [ref.slice(LEGEND_PRODUCT_REF.length)] : []));
var legendAgainstManifest = (legend, manifest) => {
	if (!isKnown(legend)) return legend;
	const checked = checkedProducts(legend.sourceRefs);
	return checked.size === new Set(manifest.products).size && manifest.products.every((id) => checked.has(id)) ? legend : { gap: "FactsUnavailable" };
};
var ACCEPTABLE = [
	"alumni",
	"credit",
	"creditUse",
	"existingSeats",
	"legend",
	"order",
	"ppp"
];
var acceptedFactsOf = (facts, manifest) => {
	const checked = {
		...facts,
		legend: legendAgainstManifest(facts.legend, manifest)
	};
	return ACCEPTABLE.flatMap((fact) => {
		const value = checked[fact];
		return "gap" in value ? [] : [{
			fact,
			productRefs: [...new Set(value.sourceRefs.filter((ref) => ref.startsWith(LEGEND_PRODUCT_REF)))].toSorted()
		}];
	});
};
var resolveIndividual = (reported, terms, quantity) => {
	const facts = {
		...reported,
		legend: legendAgainstManifest(reported.legend, terms.legend.manifest)
	};
	const { alumni, credit, creditUse, legend, ppp } = facts;
	if (quantity !== 1) return { held: [reason("individual-quantity", `${quantity} seats need a team order`)] };
	if (isKnown(credit) && credit.value !== null && !terms.creditAmounts.includes(credit.value.paid)) return { held: [reason("credit-amount-unrecognized", `${credit.value.paid} cents`)] };
	const creditClosed = isKnown(credit) && credit.value === null || isKnown(creditUse) && creditUse.value === "spent";
	const unresolved = INDIVIDUAL_FACTS.flatMap((field) => {
		const fact = facts[field];
		const candidate = UNLOCKS[field];
		return "gap" in fact && !(candidate === "credit" && creditClosed) ? [{
			candidate,
			fact: field,
			gap: fact.gap,
			needs: `${field}: ${needs(field, terms)}`
		}] : [];
	});
	return {
		facts,
		gaps: gaps({
			alumni,
			credit,
			creditUse,
			legend,
			ppp
		}),
		resolved: {
			alumni: isKnown(alumni) && alumni.value !== "none",
			credit: isKnown(credit) && isKnown(creditUse) && creditUse.value !== "spent" ? credit.value : null,
			legend: isKnown(legend) && legend.value === "verified",
			order: "individual",
			ppp: isKnown(ppp) ? ppp.value : null,
			seats: quantity
		},
		unresolved
	};
};
var resolveBuyer = (facts, terms, quantity) => {
	const { existingSeats, order } = facts;
	if (!isKnown(order)) return { held: gaps({ order }) };
	if (order.value === "individual") return resolveIndividual(facts, terms, quantity);
	return isKnown(existingSeats) ? {
		facts: null,
		gaps: [],
		resolved: teamBuyer(existingSeats.value + quantity),
		unresolved: []
	} : { held: gaps({ existingSeats }) };
};
var mostCredit = (facts, terms) => {
	const { credit, creditUse } = facts;
	if (isKnown(creditUse) && creditUse.value === "spent") return 0;
	return isKnown(credit) ? credit.value?.paid ?? 0 : Math.max(0, ...terms.creditAmounts);
};
var lowestReachable = (candidate, facts, terms, phase) => {
	const credit = mostCredit(facts, terms);
	const alumniBase = percentOff(terms.list, terms.alumniPercent);
	const alumniPossible = !isKnown(facts.alumni) || facts.alumni.value !== "none";
	const newBase = percentOff(terms.list, phase === "early" ? terms.newBuyerEarlyPercent : 0);
	return {
		alumni: minus(alumniBase, credit),
		credit: minus(alumniPossible ? Math.min(newBase, alumniBase) : newBase, credit),
		legend: minus(percentOff(terms.list, terms.legend.percent), terms.legend.credit),
		ppp: 0
	}[candidate];
};
var couldLower = (unresolved, facts, context) => facts === null ? [] : unresolved.filter(({ candidate }) => lowestReachable(candidate, facts, context.terms, context.phase) < context.selected);
var cohort005Pricer = (rules, rank = cohort005Rank) => {
	const select = {
		individual: pricer(rules.filter((rule) => rule.order === "individual"), rank),
		team: pricer(rules.filter((rule) => rule.order === "team"), rank)
	};
	return (buyerFacts, product, quantity, now, quotes) => {
		const { policy } = product;
		if (!policy.enabled) return {
			kind: "held",
			reasons: [reason("policy-disabled", policy.version)]
		};
		const terms = resolveTerms(policy);
		if ("held" in terms) return {
			kind: "held",
			reasons: terms.held
		};
		if (product.merchantUnit !== terms.resolved.list || product.id !== policy.product) return {
			kind: "held",
			reasons: [reason("merchant-price-mismatch", product.id)]
		};
		const at = toEpochMillis(now);
		const closed = closure(terms.resolved, at);
		if (closed !== null) return closed;
		const buyer = resolveBuyer(buyerFacts, terms.resolved, quantity);
		if ("held" in buyer) return {
			kind: "held",
			reasons: buyer.held
		};
		const phase = at < toEpochMillis(terms.resolved.earlyEndsAt) ? "early" : "standard";
		const outcomes = quotes.map((quote) => quoteOutcome(quote, product.id, quantity, now));
		const quoteReasons = outcomes.filter((outcome) => "code" in outcome).toSorted((left, right) => left.detail.localeCompare(right.detail));
		if (quoteReasons.some((item) => item.code === "quote-basis-unknown")) return {
			kind: "held",
			reasons: quoteReasons
		};
		const { ppp } = buyer.resolved;
		const { candidates, chosen: selected, offers } = select[buyer.resolved.order]({
			buyer: buyer.resolved,
			phase,
			quantity,
			terms: terms.resolved
		}, (consent) => consent === "region" && ppp !== null && ppp.accepted, outcomes.filter((outcome) => "rule" in outcome));
		if (selected === void 0) return {
			kind: "held",
			reasons: [reason("fact-unknown", "no candidate")]
		};
		const spent = buyer.resolved.order === "individual" && isKnown(buyerFacts.creditUse) && buyerFacts.creditUse.value === "spent" && isKnown(buyerFacts.credit) && buyerFacts.credit.value !== null;
		const decided = {
			...selected,
			acceptedFacts: acceptedFactsOf(buyerFacts, terms.resolved.legend.manifest),
			candidates,
			engineVersion: ENGINE_VERSION$1,
			offers,
			policyVersion: policy.version,
			reasons: [
				reason(phase === "early" ? "early-window" : "standard-window"),
				...spent ? [reason("credit-spent")] : [],
				...buyer.gaps,
				...quoteReasons,
				reason("selected", selected.rule)
			]
		};
		const unresolved = couldLower(buyer.unresolved, buyer.facts, {
			phase,
			selected: selected.amount,
			terms: terms.resolved
		});
		return unresolved.length === 0 ? {
			...decided,
			kind: "priced"
		} : {
			...decided,
			kind: "bounded",
			unresolved
		};
	};
};
var price$1 = cohort005Pricer(cohort005Rules);
Literals([
	"team",
	"legend",
	"alumni",
	"new",
	"ppp",
	"quote"
]);
var BuyerFactField = Literals([
	"alumni",
	"credit",
	"creditUse",
	"legend",
	"ppp"
]);
var PricingResult = pricingResultOf(Struct({
	candidate: Literals([
		"alumni",
		"credit",
		"legend",
		"ppp"
	]).annotate({ description: "The discount that could still lower the price" }),
	fact: BuyerFactField.annotate({ description: "The buyer fact that would decide it" }),
	gap: FactGap.annotate({ description: "Why that fact is unknown" }),
	needs: String$1.annotate({ description: "What would resolve the fact, never customer text" })
}), Struct({
	fact: Literals([
		"alumni",
		"credit",
		"creditUse",
		"existingSeats",
		"legend",
		"order",
		"ppp"
	]).annotate({ description: "A buyer fact the engine accepted as known; a legend fact only after its products matched the policy manifest" }),
	productRefs: ArraySchema(String$1).annotate({ description: "The fact's product:<id> source refs, such as the products a legend fact was checked against. Other refs are left out because they can name buyer records" })
}));
//#endregion
//#region src/public/index.ts
var ENGINE_VERSION = ENGINE_VERSION$1;
var decodeRequest = decoderOf(Struct({
	facts: BuyerFacts,
	now: Instant,
	product: Product,
	quantity: Quantity,
	quotes: ArraySchema(BindingQuote)
}));
var encodeResult = encodeSync(PricingResult);
var decodePolicy = plainDecoderOf(PricingPolicy);
var decodeBindingQuotes = plainDecoderOf(ArraySchema(BindingQuote));
var price = (request) => {
	const checked = decodeRequest(request);
	if (!checked.ok) return checked;
	const { facts, now, product, quantity, quotes } = checked.value;
	return {
		ok: true,
		value: encodeResult(price$1(facts, product, quantity, now, quotes))
	};
};
//#endregion
export { ENGINE_VERSION, decodeBindingQuotes, decodePolicy, price };
