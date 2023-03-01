// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.4;

import "./interfaces/INftfiHub.sol";
import "./interfaces/IDirectLoanCoordinator.sol";
import "./loans/direct/loanTypes/DirectLoanBaseMinimal.sol";
import "./loans/direct/loanTypes/LoanData.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title  NftSec
 * @author Nathan Sheng
 * @notice Contract for securitizing pools of loans originated on NFTfi. Tranches are represented as ERC-1155 tokens.
 */
contract NftSec is ERC1155Supply, IERC1155Receiver, IERC721Receiver {

    struct Underlying {
        uint256 loanPrincipal;
        uint256 loanProceeds;
        uint64 loanEndTime;
        uint256 auctionEndTime;
        uint32 loanId;
        bool liquidated;
    }

    struct Product {
        address owner;
        uint256 tokenOffset;
        uint256[] trancheInterestRates;
        uint256[] trancheNotionals;
        Underlying[] underlyings;
        uint256[] tranchePayouts;
        bool payoutsComputed;
        uint256 startTime;
        uint256 endTime;
        uint256 residualPrice;
    }

    struct UnderlyingLookup {
        uint32 productId;
        uint32 underlyingIndex;
    }

    uint64 private constant DAY_IN_SECONDS = 86400;
    // address private constant WETH = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    // address private constant NFTFI = address(0x8252Df1d8b29057d1Afe3062bf5a64D503152BC8);
    // address private constant NFTFI_HUB = address(0xd99b8075Cb583FdE8F60A2C3aC84eE37c701a578);
    // address private constant ERC721_WRAPPER = address(0xB2C2fCe38a0B7A89aB51F046B7052892Ba55EB2B);
    // address private constant PERMISSORY_NOTE = address(0x5660E206496808F7b5cDB8C56A696a96AE5E9b23);
    // uint256 private constant MIN_AUCTION_TIME = 5 * DAY_IN_SECONDS;
    // uint256 private constant BOUNTY_TIME = 1 * DAY_IN_SECONDS;
    address private WETH;
    address private NFTFI;
    address private NFTFI_HUB;
    address private ERC721_WRAPPER;
    address private PERMISSORY_NOTE;
    uint256 private MIN_AUCTION_TIME;
    uint256 private BOUNTY_TIME;

    mapping(uint32 => Product) private productIdToProduct;
    mapping(address => mapping(uint256 => UnderlyingLookup)) private nftIdToLookup;
    uint32 private currentProductId = 0;
    uint256 private currentTokenOffset = 0;

    constructor(
        address weth,
        address nftfi,
        address nftfiHub,
        address erc721Wrapper,
        address permissoryNote,
        uint256 minAuctionTime,
        uint256 bountyTime
    ) ERC1155("INSERT_URI_HERE") {
        WETH = weth;
        NFTFI = nftfi;
        NFTFI_HUB = nftfiHub;
        ERC721_WRAPPER = erc721Wrapper;
        PERMISSORY_NOTE = permissoryNote;
        MIN_AUCTION_TIME = minAuctionTime;
        BOUNTY_TIME = bountyTime;
    }

    function mint(
        uint256[] calldata trancheInterestRates,
        uint256[] calldata trancheNotionals,
        uint32[] calldata loanIds,
        uint256 productDuration,
        uint256 residualPrice
    ) external {
        require(trancheInterestRates.length < 32, "Too many tranches");
        require(
            trancheInterestRates.length == trancheNotionals.length
                || trancheInterestRates.length == 0 && trancheNotionals.length == 2,
            "Number of interest rates and notionals don't match");

        IDirectLoanCoordinator loanCoordinator = IDirectLoanCoordinator(INftfiHub(NFTFI_HUB).getContract(DirectLoanBaseMinimal(NFTFI).LOAN_COORDINATOR()));
        Product storage product = productIdToProduct[currentProductId];
        Underlying memory underlying;
        LoanData.LoanTerms memory loanTerms;
        underlying.auctionEndTime = block.timestamp + productDuration;
        for (uint32 i = 0; i < loanIds.length; i++) {
            underlying.loanId = loanIds[i];
            (bool success, bytes memory data) = NFTFI.staticcall(abi.encodeWithSignature("loanIdToLoan(uint32)", underlying.loanId));
            require(success, "Fetching loan ID from NFTfi failed");
            loanTerms = abi.decode(data, (LoanData.LoanTerms));
            require(loanTerms.loanERC20Denomination == WETH, "Only wETH-denominated loans allowed");
            require(loanTerms.nftCollateralWrapper == ERC721_WRAPPER, "Only loans with ERC-721 collateral allowed");
            IERC721(PERMISSORY_NOTE).transferFrom(msg.sender, address(this), loanCoordinator.getLoanData(underlying.loanId).smartNftId);
            underlying.loanPrincipal = loanTerms.loanPrincipalAmount;
            underlying.loanProceeds = (loanTerms.maximumRepaymentAmount - underlying.loanPrincipal) * (10000 - loanTerms.loanAdminFeeInBasisPoints) / 10000 + underlying.loanPrincipal;
            underlying.loanEndTime = loanTerms.loanStartTime + loanTerms.loanDuration;
            require(underlying.loanEndTime + MIN_AUCTION_TIME + BOUNTY_TIME < underlying.auctionEndTime, "Product duration too short for underlyings");
            nftIdToLookup[loanTerms.nftCollateralContract][loanTerms.nftCollateralId] = UnderlyingLookup(currentProductId, i);
            product.underlyings.push(underlying);
        }
        product.owner = msg.sender;
        product.tokenOffset = currentTokenOffset;
        product.startTime = block.timestamp;
        product.endTime = product.startTime + productDuration;
        product.residualPrice = residualPrice;
        if (trancheInterestRates.length == 0) {
            product.trancheNotionals.push(trancheNotionals[0]);
            product.trancheNotionals.push(trancheNotionals[1]);
        } else {
            for (uint8 trancheId = 0; trancheId < trancheInterestRates.length; trancheId++) {
                product.trancheInterestRates.push(trancheInterestRates[trancheId]);
                product.trancheNotionals.push(trancheNotionals[trancheId]);
            }
        }
        currentProductId += 1;

        for (uint8 trancheId = 0; trancheId < trancheNotionals.length; trancheId++) {
            _mint(address(this), trancheId + currentTokenOffset, trancheNotionals[trancheId], "");
        }
        _mint(address(this), currentTokenOffset + trancheNotionals.length, 1, "");
        currentTokenOffset += trancheNotionals.length + 1;
    }

    function buyResidual(uint32 productId) external {
        Product storage product = productIdToProduct[productId];
        IERC20(WETH).transferFrom(msg.sender, product.owner, product.residualPrice);
        this.safeTransferFrom(address(this), msg.sender, product.trancheNotionals.length + product.tokenOffset, 1, "");
    }

    function buyTokens(uint32 productId, uint8 trancheId, uint256 amount) external {
        Product storage product = productIdToProduct[productId];
        require(trancheId < product.trancheNotionals.length, "Invalid tranche ID");
        uint256 price = _getTokenPrice(product);
        IERC20(WETH).transferFrom(msg.sender, product.owner, price * amount / 10000);
        this.safeTransferFrom(address(this), msg.sender, trancheId + product.tokenOffset, amount, "");
    }

    function redeemTokens(uint32 productId) external {
        Product storage product = productIdToProduct[productId];
        require(
            product.payoutsComputed
                || block.timestamp > product.endTime
                || (
                    block.timestamp > product.endTime - BOUNTY_TIME
                    && balanceOf(msg.sender, product.trancheNotionals.length) == 1
                ),
            "Token not yet ready for redemption"
        );

        IERC20 weth = IERC20(WETH);
        bool isIOPO = product.trancheInterestRates.length == 0;
        if (!product.payoutsComputed) {
            DirectLoanBaseMinimal nftfi = DirectLoanBaseMinimal(NFTFI);
            uint256 totalProceeds;
            uint256 totalPrincipal;
            uint256 totalInterest;
            for (uint32 i = 0; i < product.underlyings.length; i++) {
                Underlying storage underlying = product.underlyings[i];
                if (underlying.liquidated || nftfi.loanRepaidOrLiquidated(underlying.loanId)) {
                    totalProceeds += underlying.loanProceeds;
                    if (isIOPO) {
                        if (underlying.liquidated) {
                            totalPrincipal += Math.min(underlying.loanPrincipal, underlying.loanProceeds);
                        } else {
                            totalPrincipal += underlying.loanPrincipal;
                            totalInterest += underlying.loanProceeds - underlying.loanPrincipal;
                        }
                    }
                }
            }
            uint256 computationBounty = 10**17;
            if (totalProceeds >= computationBounty) {
                totalProceeds -= computationBounty;
            } else {
                computationBounty = totalProceeds;
                totalProceeds = 0;
            }
            if (isIOPO) {
                if (totalProceeds >= totalInterest) {
                    product.tranchePayouts.push(totalInterest);
                    if (totalProceeds >= totalInterest + totalPrincipal) {
                        product.tranchePayouts.push(totalPrincipal);
                        product.tranchePayouts.push(totalProceeds - totalInterest - totalPrincipal);
                    } else {
                        product.tranchePayouts.push(totalProceeds - totalInterest);
                        product.tranchePayouts.push(0);
                    }
                } else {
                    product.tranchePayouts.push(totalProceeds);
                    product.tranchePayouts.push(0);
                    product.tranchePayouts.push(0);
                }
            } else {
                for (uint8 trancheId = 0; trancheId < product.trancheInterestRates.length; trancheId++) {
                    uint256 expectedPayout = product.trancheNotionals[trancheId] * (10000 + product.trancheInterestRates[trancheId]) / 10000;
                    if (totalProceeds >= expectedPayout) {
                        product.tranchePayouts.push(expectedPayout);
                        totalProceeds -= expectedPayout;
                    } else {
                        product.tranchePayouts.push(Math.min(weth.balanceOf(address(this)), totalProceeds));
                        totalProceeds = 0;
                        for (; trancheId < product.trancheInterestRates.length; trancheId++) {
                            product.tranchePayouts.push(0);
                        }
                        break;
                    }
                }
                product.tranchePayouts.push(Math.min(weth.balanceOf(address(this)), totalProceeds)); // remaining goes to residual
            }
            product.payoutsComputed = true;
            weth.transfer(msg.sender, computationBounty);
        }

        for (
            uint256 trancheId = 0;
            trancheId < product.tranchePayouts.length;
            trancheId++
        ) {
            uint256 tokenId = trancheId + product.tokenOffset;
            uint256 balance = balanceOf(msg.sender, tokenId);
            if (balance > 0) {
                _burn(msg.sender, tokenId, balance);
                if (trancheId == product.tranchePayouts.length - 1) {
                    weth.transfer(msg.sender, product.tranchePayouts[trancheId]);
                } else {
                    weth.transfer(msg.sender, product.tranchePayouts[trancheId] * balance / product.trancheNotionals[trancheId]);
                }
            }
        }
    }

    function liquidateNft(address nftContract, uint256 nftId) external {
        Underlying storage underlying = _getUnderlying(nftContract, nftId);
        uint256 nftPrice = _getNftPrice(underlying.loanPrincipal, underlying.loanEndTime, underlying.auctionEndTime);
        IERC20(WETH).transferFrom(msg.sender, address(this), nftPrice);
        DirectLoanBaseMinimal(NFTFI).liquidateOverdueLoan(underlying.loanId);
        IERC721(nftContract).transferFrom(address(this), msg.sender, nftId);
        underlying.loanProceeds = nftPrice;
    }

    function getResidualTokenId(uint32 productId) external view returns (uint256) {
        Product memory product = productIdToProduct[productId];
        return product.trancheNotionals.length + product.tokenOffset;
    }

    function getTokenId(uint32 productId, uint8 trancheId) external view returns (uint256) {
        Product memory product = productIdToProduct[productId];
        require(trancheId < product.trancheNotionals.length, "Invalid tranche ID");
        return trancheId + product.tokenOffset;
    }

    function getResidualPrice(uint32 productId) external view returns (uint256) {
        Product memory product = productIdToProduct[productId];
        require(_getTokenQuantity(product, uint8(product.trancheNotionals.length)) == 1, "Residual already purchased");
        return product.residualPrice;
    }

    function getTokenPrice(uint32 productId, uint8 trancheId) external view returns (uint256) {
        Product memory product = productIdToProduct[productId];
        require(trancheId < product.trancheNotionals.length, "Invalid tranche ID");
        require(_getTokenQuantity(product, trancheId) > 0, "No supply remaining");
        return _getTokenPrice(product);
    }

    function getTokenQuantity(uint32 productId, uint8 trancheId) external view returns (uint256) {
        Product memory product = productIdToProduct[productId];
        return _getTokenQuantity(product, trancheId);
    }

    function getNftPrice(address nftContract, uint256 nftId) external view returns (uint256) {
        Underlying storage underlying = _getUnderlying(nftContract, nftId);
        require(block.timestamp > underlying.loanEndTime, "Loan not expired yet");
        require(!DirectLoanBaseMinimal(NFTFI).loanRepaidOrLiquidated(underlying.loanId), "Loan already repaid or liquidated");
        return _getNftPrice(underlying.loanPrincipal, underlying.loanEndTime, underlying.auctionEndTime);
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external virtual override returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external virtual override returns (bytes4) {
        revert("ERC1155 batch not supported");
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external virtual override returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function _getUnderlying(address nftContract, uint256 nftId) internal view returns (Underlying storage) {
        UnderlyingLookup memory lookup = nftIdToLookup[nftContract][nftId];
        return productIdToProduct[lookup.productId].underlyings[lookup.underlyingIndex];
    }

    function _getTokenQuantity(Product memory product, uint8 trancheId) internal view returns (uint256) {
        return balanceOf(address(this), trancheId + product.tokenOffset);
    }

    function _getTokenPrice(Product memory product) internal view returns (uint256) {
        // Begin sale at price 1.03 wei, and decay linearly until 0 wei at tranche payout time
        if (block.timestamp > product.endTime) {
            return 0;
        } else {
            return 10300 * (product.endTime - block.timestamp) / (product.endTime - product.startTime);
        }
    }

    function _getNftPrice(uint256 loanPrincipal, uint64 loanEndTime, uint256 auctionEndTime) internal view returns (uint256) {
        // Begin sale at price equal to 2x original loan principal, and decay linearly until 0 ETH at tranche payout time
        if (block.timestamp > auctionEndTime) {
            return 0;
        } else {
            return 2 * loanPrincipal * (auctionEndTime - block.timestamp) / (auctionEndTime - loanEndTime);
        }
    }
}