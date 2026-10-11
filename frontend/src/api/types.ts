import type { components } from './schema';

type Schemas = components['schemas'];

export type AnomalyAssessment = Schemas['AnomalyAssessment'];
export type AlarmDetail = Schemas['AlarmDetail'];
export type AlarmEventOut = Schemas['AlarmEventOut'];
export type AlarmKind = Schemas['AlarmKind'];
export type AlarmList = Schemas['AlarmList'];
export type AlarmOut = Schemas['AlarmOut'];
export type AlarmRuleOut = Schemas['AlarmRuleOut'];
export type AlarmState = Schemas['AlarmState'];
export type AlarmCounts = Schemas['AlarmCounts'];
export type Communication = Schemas['Communication'];
export type DataGap = Schemas['DataGap'];
export type EquipmentDetail = Schemas['EquipmentDetail'];
export type FleetSummary = Schemas['FleetSummary'];
export type Health = Schemas['Health'];
export type HistoryBucket = Schemas['HistoryBucket'];
export type HistoryPoint = Schemas['HistoryPoint'];
export type HistoryResponse = Schemas['HistoryResponse'];
export type IncidentWindow = Schemas['IncidentWindow'];
export type IngestionStats = Schemas['IngestionStats'];
export type LatestReading = Schemas['LatestReading'];
export type OpcUaStatus = Schemas['OpcUaStatus'];
export type Quality = Schemas['Quality'];
export type RecentEvent = Schemas['RecentEvent'];
export type Role = Schemas['Role'];
export type ScenarioInfo = Schemas['ScenarioInfo'];
export type ScenarioResult = Schemas['ScenarioResult'];
export type ActiveScenario = Schemas['ActiveScenario'];
export type SeriesOut = Schemas['SeriesOut'];
export type SeriesPoint = Schemas['SeriesPoint'];
export type Severity = Schemas['Severity'];
export type SimulatorEventOut = Schemas['SimulatorEventOut'];
export type SimulatorStatus = Schemas['SimulatorStatus'];
export type StatePoint = Schemas['StatePoint'];
export type SystemStatus = Schemas['SystemStatus'];
export type TokenResponse = Schemas['TokenResponse'];
export type UserOut = Schemas['UserOut'];
export type VesselDetail = Schemas['VesselDetail'];
export type VesselSummary = Schemas['VesselSummary'];

export const ALARM_STATES: readonly AlarmState[] = [
  'active_unacknowledged',
  'active_acknowledged',
  'cleared_unacknowledged',
  'cleared',
];
export const SEVERITIES: readonly Severity[] = ['info', 'warning', 'critical'];
export const ALARM_KINDS: readonly AlarmKind[] = ['condition', 'data_quality', 'communication'];
