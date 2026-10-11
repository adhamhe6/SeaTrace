class SimulatorUnavailableError(Exception):
    """The OPC UA session to the simulator is not established."""


class SimulatorCommandError(Exception):
    """A control call reached the simulator but failed at the protocol level."""
