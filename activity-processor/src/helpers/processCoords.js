"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promise_1 = __importDefault(require("mysql2/promise"));
const distanceMetersToDegrees_1 = __importDefault(require("./distanceMetersToDegrees"));
const getBoundingBox_1 = __importDefault(require("./getBoundingBox"));
const compareCoords_1 = __importDefault(require("./compareCoords"));
const getSummits_1 = __importDefault(require("./getSummits"));
const processCoords = (coords) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const connection = yield promise_1.default.createConnection({
        host: "127.0.0.1",
        user: "local-user",
        database: "dev-db",
        password: (_a = process.env.MYSQL_PASSWORD) !== null && _a !== void 0 ? _a : "",
    });
    const initialCoords = coords[0];
    const delta = (0, distanceMetersToDegrees_1.default)(30, initialCoords[0]);
    const boundingBox = coords.reduce((acc, [lat, long]) => (0, getBoundingBox_1.default)(acc, [lat, long], delta), {
        minLat: initialCoords[0] - delta.lat,
        maxLat: initialCoords[0] + delta.lat,
        minLong: initialCoords[1] - delta.long,
        maxLong: initialCoords[1] + delta.long,
    });
    const [rows] = yield connection.execute(`SELECT * FROM Peak WHERE Lat BETWEEN ${boundingBox.minLat} AND ${boundingBox.maxLat} AND \`Long\` BETWEEN ${boundingBox.minLong} AND ${boundingBox.maxLong}`);
    const coordResults = coords.map(([lat, long]) => {
        return rows
            .filter((x) => (0, compareCoords_1.default)(x, lat, long, delta))
            .map((x) => x.Id);
    });
    const taggedSummits = coordResults.reduce(getSummits_1.default, {});
    Object.keys(taggedSummits).forEach((key) => {
        const peak = rows.find((x) => x.Id === key);
        if (peak) {
            console.log(`${peak.Name} has been tagged ${taggedSummits[key].count} time${taggedSummits[key].count === 1 ? "" : "s"}`);
        }
    });
});
exports.default = processCoords;
