'use strict';
// Every outcome code the harness can give a command (log.out.* in js/openai-ai.js, plus
// the parser's own), in one of five classes. WAR Bench scores and baselines read this
// table and nothing else; tests/bench-taxonomy.test.cjs holds it to the harness both
// ways -- every code the harness can emit is here, and every code here still exists.
//
//   done        the command took effect
//   constraint  a well-formed command the world refused: cannot afford, busy, a
//               prerequisite missing, nobody free to do it. A legal move, badly timed.
//   contended   refused for something no snapshot could have forewarned
//               (OpenAIAIManager.UNFOREWARNED): the state was true when read.
//   reference   the command named something that is not there or cannot be meant: an
//               unknown unit, tech, building or target, a selection matching nothing,
//               a malformed call. The random-valid baseline must never earn one.
//   harness     the harness failed, not the seat
//   meta        not a command's outcome: log lines about lanes, rounds and healing
const CLASSES = Object.freeze({
    done: ['ageUpStarted', 'assignQueued', 'attackDispatched', 'attackEngaging', 'attackMarching', 'attackMoving',
        'buildStarted', 'deleted', 'destroyed', 'exploreSent', 'moveUnits', 'reassigned', 'repairStarted',
        'researchStarted', 'trainUnit'],
    constraint: ['alreadyResearched', 'alreadyResearching', 'alreadyUpgrading', 'alreadyWonder', 'assignFromBusy',
        'assignFromEmpty', 'assignIdleTaken', 'buildNeedsTech', 'buildingCannotTrainTier', 'buildingNeedsAge',
        'buildingUnderConstr', 'cannotAfford', 'exploreAlreadySent', 'farmAllManned', 'farmManned', 'farmUnderConstr',
        'laneDuplicateAge', 'laneDuplicateBuilding', 'laneDuplicateTech', 'maxAge', 'missingPrereq',
        'noBuildingDestroy', 'noBuildingTrains', 'noDamagedNear', 'noFinishedFarms', 'noMilitaryAttack',
        'noMilitaryMove', 'noTCPlacement', 'noTCTrain', 'noTCWorkers', 'noUnitDelete', 'noUnitExplore',
        'noWorkersBuild', 'noWorkersForFarms', 'noWorkersReassign', 'noWorkersRepair', 'noWorkersScouting', 'notDiscovered',
        'nothingToRepair', 'populationHardCap', 'populationLimit', 'refuseDestroyLastTC', 'repairFailed',
        'researchedElsewhere', 'techNeedsAge', 'unitBuildingNotBuilt', 'unitBuildingNotUnlocked', 'unitNeedsAge'],
    contended: ['assignAllCarrying', 'assignFromRaced', 'assignIdleFighting', 'assignIdleRaced', 'laneResearchBusy',
        'noClearSpot', 'noWorkerIdleBuild', 'orderedUnitsGone', 'targetGone', 'trainerBusy'],
    reference: ['assignBadCarry', 'assignBadFrom', 'assignBadSpill', 'assignFromSame', 'assignNeedsCoords',
        'assignNeedsResource', 'attackNeedsCoords', 'attackNoMatch', 'civCannotBuild', 'civCannotTrain',
        'exploreBadTile', 'exploreNeedsTile', 'farmNeedsCoords', 'moveNeedsCoords', 'moveNoMatch',
        'notAResearchTech', 'notACommand', 'offMap', 'renamedBuilding', 'repairNeedsCoords', 'targetIsOwn',
        'targetNotFound', 'techIsBuilding', 'unknownBuilding', 'unknownTech', 'unknownUnit', 'unparsedCall', 'rawToolMarkup'],
    harness: ['executionFailed'],
    meta: ['healDropped', 'healStripped', 'laneDropped', 'roundMissed'],
});

const CLASS_OF = Object.freeze(Object.fromEntries(
    Object.entries(CLASSES).flatMap(([cls, codes]) => codes.map(c => [c, cls]))));

// The class of one recorded outcome ({code, verdict} as takeOutcomes returns it). A
// rejection that carries no code is 'uncoded': the harness refused it without saying
// why in its own vocabulary, which the taxonomy check counts rather than hides.
function classify(outcome) {
    if (!outcome) return 'uncoded';
    if (outcome.code && CLASS_OF[outcome.code]) return CLASS_OF[outcome.code];
    if (outcome.verdict === 'ok') return 'done';
    return outcome.code ? 'unknown:' + outcome.code : 'uncoded';
}

module.exports = { CLASSES, CLASS_OF, classify };
